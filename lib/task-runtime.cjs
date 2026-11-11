'use strict';

const fs = require('node:fs');
const path = require('node:path');

const num = (value, fallback = 0) => {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const text = (value) => value == null ? '' : Array.isArray(value) ? value.join('、') : String(value);
const round = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

function tableRows(snapshot, name) {
  const table = Object.values(snapshot?.tables || {}).find((item) => item.name === name);
  return table ? Object.entries(table.records || {}).map(([record_id, fields]) => ({ record_id, ...fields })) : [];
}

function hashNumber(value, min, max) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const ratio = (hash >>> 0) / 0xffffffff;
  return min + ratio * (max - min);
}

function parseRequest(request, fallback = {}) {
  const source = text(request).trim();
  const quantityMatch = source.match(/(\d+(?:\.\d+)?)\s*(?:套|台|件)/);
  const codeMatch = source.match(/\b[A-Z][A-Z0-9.-]{3,}\b/i);
  const quantity = Math.max(1, Math.round(num(fallback.quantity || (quantityMatch && quantityMatch[1]), 100)));
  const productCode = text(fallback.product_code || (codeMatch && codeMatch[0]) || '').trim();
  return { request: source, quantity, product_code: productCode };
}

class TaskRuntime {
  constructor({ dataDir, getSnapshot }) {
    this.getSnapshot = getSnapshot;
    this.file = path.join(dataDir, 'tasks.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.tasks = this._load();
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  _save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.tasks.slice(0, 100), null, 2));
    fs.renameSync(tmp, this.file);
  }

  list(limit = 20) {
    return this.tasks.slice(0, Math.min(100, Math.max(1, Number(limit) || 20)));
  }

  get(id) {
    return this.tasks.find((task) => task.id === id) || null;
  }

  run(input = {}) {
    const snapshot = this.getSnapshot();
    if (!snapshot) throw new Error('飞书尚未完成首次同步');

    const parsed = parseRequest(input.request, input);
    const materialRows = tableRows(snapshot, '产品物料基础资料').filter((row) => text(row['类型']) === '物料' && num(row['标准用量']) > 0);
    const productRows = tableRows(snapshot, '产品物料基础资料').filter((row) => text(row['类型']) === '产品');
    if (!materialRows.length) throw new Error('飞书缺少可计算的物料标准用量');

    const product = productRows.find((row) => {
      const code = text(row['编码']).toLowerCase();
      const name = text(row['名称']).toLowerCase();
      const needle = parsed.product_code.toLowerCase();
      return needle && (code === needle || name.includes(needle));
    });
    const productCode = product ? text(product['编码']) : (parsed.product_code || '未指定产品');
    const productName = product ? text(product['名称']) : productCode;

    const materials = materialRows.map((row) => {
      const code = text(row['编码']);
      const standardUsage = num(row['标准用量']);
      const required = round(standardUsage * parsed.quantity);
      const currentStock = num(row['目前库存']);
      const remainingStock = num(row['剩余库存'], currentStock);
      const reserved = Math.min(remainingStock, Math.floor(hashNumber(`${code}:reserved`, 0, Math.max(1, currentStock * 0.08))));
      const inTransit = Math.floor(hashNumber(`${code}:transit`, 0, Math.max(1, required * 0.12)));
      const safetyStock = Math.ceil(required * 0.1);
      const availableNow = Math.max(0, remainingStock - reserved);
      const projectedAvailable = availableNow + inTransit;
      const shortage = Math.max(0, round(required + safetyStock - projectedAvailable));
      return {
        code,
        name: text(row['名称']),
        unit: text(row['单位']),
        standard_usage: standardUsage,
        required,
        current_stock: currentStock,
        remaining_stock: remainingStock,
        supplier: text(row['供应商']) || '待维护',
        reserved,
        in_transit: inTransit,
        safety_stock: safetyStock,
        available_now: availableNow,
        projected_available: projectedAvailable,
        shortage,
        sources: {
          feishu: ['编码', '名称', '单位', '标准用量', '目前库存', '剩余库存', '供应商'],
          simulated: ['产品与物料的 BOM 归属', '预留数量', '在途数量', '安全库存'],
        },
      };
    });

    const quotes = materials.filter((item) => item.shortage > 0).map((item) => {
      const unitPrice = round(hashNumber(`${item.code}:price`, 8, 180));
      const moqOptions = [1, 10, 20, 50];
      const moq = moqOptions[Math.floor(hashNumber(`${item.code}:moq`, 0, moqOptions.length - 0.001))];
      const orderQuantity = Math.ceil(item.shortage / moq) * moq;
      const leadDays = Math.round(hashNumber(`${item.code}:lead`, 3, 16));
      const freight = round(hashNumber(`${item.code}:freight`, 20, 180));
      const subtotal = round(orderQuantity * unitPrice);
      return {
        material_code: item.code,
        material_name: item.name,
        supplier: item.supplier,
        shortage: item.shortage,
        order_quantity: orderQuantity,
        unit: item.unit,
        unit_price: unitPrice,
        moq,
        lead_days: leadDays,
        freight,
        subtotal,
        source: 'simulated',
      };
    });

    const inventoryUseCost = round(materials.reduce((total, item) => {
      const simulatedUnitCost = hashNumber(`${item.code}:price`, 8, 180) * 0.92;
      return total + Math.min(item.required, item.available_now) * simulatedUnitCost;
    }, 0));
    const purchaseSubtotal = round(quotes.reduce((total, quote) => total + quote.subtotal, 0));
    const freight = round(quotes.reduce((total, quote) => total + quote.freight, 0));
    const taxRate = 0.13;
    const tax = round(purchaseSubtotal * taxRate);
    const totalEstimate = round(inventoryUseCost + purchaseSubtotal + freight + tax);

    const now = new Date().toISOString();
    const warnings = [
      '飞书当前没有产品到物料的 BOM 关联，本任务暂按全部物料记录作为演示 BOM。',
      '预留、在途、安全库存、报价、MOQ、交期、税率、运费和单位成本均为模拟数据。',
      '任务审批仅更新本地任务状态，不会写回飞书。',
    ];
    if (!product) warnings.unshift(`飞书中未找到产品「${productCode}」，保留用户输入作为演示产品。`);

    const steps = [
      { id: 'ceo', agent: 'CEO 总助 Agent', status: 'completed', action: '解析产品和数量，创建跨部门任务', sources: ['用户指令'], result: `${productCode} × ${parsed.quantity}` },
      { id: 'production', agent: '生产 Agent', status: 'completed', action: '读取标准用量并生成物料需求', sources: ['飞书·产品物料基础资料', '模拟·BOM 归属'], result: `${materials.length} 种物料` },
      { id: 'warehouse', agent: '仓储 Agent', status: 'completed', action: '计算当前可用量、在途和安全库存', sources: ['飞书·库存字段', '模拟·预留/在途/安全库存'], result: `${materials.filter((item) => item.shortage > 0).length} 种缺口` },
      { id: 'purchase', agent: '采购 Agent', status: 'completed', action: '生成补货数量和供应商报价建议', sources: ['飞书·供应商', '模拟·报价/MOQ/交期'], result: `${quotes.length} 项待采购` },
      { id: 'finance', agent: '财务 Agent', status: 'completed', action: '汇总库存耗用、采购、税费和运费', sources: ['跨部门计算结果', '模拟·成本字段'], result: `¥${totalEstimate.toLocaleString('zh-CN')}` },
      { id: 'approval', agent: 'CEO 人工审批', status: 'waiting_approval', action: '确认建议后决定是否进入写回阶段', sources: ['全部 Agent 结果'], result: '等待审批' },
    ];

    const task = {
      id: `TASK-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`,
      created_at: now,
      updated_at: now,
      status: 'awaiting_approval',
      input: { request: parsed.request, product_code: productCode, product_name: productName, quantity: parsed.quantity },
      data_policy: { real_source: 'Feishu Bitable', missing_fields: 'simulated', writeback: false, snapshot_at: snapshot.synced_at },
      steps,
      result: {
        materials,
        purchase_quotes: quotes,
        finance: { currency: 'CNY', inventory_use_cost: inventoryUseCost, purchase_subtotal: purchaseSubtotal, freight, tax_rate: taxRate, tax, total_estimate: totalEstimate, source: 'simulated' },
        warnings,
      },
      approval: { required: true, status: 'pending', approved_at: null, note: null, writes_to_feishu: false },
    };
    this.tasks.unshift(task);
    this._save();
    return task;
  }

  approve(id, note = '') {
    const task = this.get(id);
    if (!task) return null;
    const now = new Date().toISOString();
    task.status = 'approved_local_only';
    task.updated_at = now;
    task.approval = { required: true, status: 'approved_local_only', approved_at: now, note: text(note), writes_to_feishu: false };
    const step = task.steps.find((item) => item.id === 'approval');
    if (step) { step.status = 'approved_local_only'; step.result = '本地批准，不写飞书'; }
    this._save();
    return task;
  }
}

module.exports = { TaskRuntime, parseRequest, tableRows };
