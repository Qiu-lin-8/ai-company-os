'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TaskRuntime, parseRequest } = require('../lib/task-runtime.cjs');

const root = path.join(__dirname, '..');
const testDir = path.join(root, 'logs', 'tmp', 'task-runtime-test');
fs.rmSync(testDir, { recursive: true, force: true });

const snapshot = {
  synced_at: '2026-11-11T00:00:00.000Z',
  tables: {
    material: {
      name: '产品物料基础资料',
      records: {
        product: { 编码: 'CP-1', 名称: '测试产品', 类型: '产品', 标准用量: 1 },
        material1: { 编码: 'WL-1', 名称: '测试物料', 类型: '物料', 单位: '个', 标准用量: 2, 目前库存: 100, 剩余库存: 20, 供应商: '测试供应商' },
      },
    },
  },
};

try {
  assert.deepEqual(parseRequest('我要生产 100 套 TCI-4T3.7GB-L'), { request: '我要生产 100 套 TCI-4T3.7GB-L', quantity: 100, product_code: 'TCI-4T3.7GB-L' });
  const runtime = new TaskRuntime({ dataDir: testDir, getSnapshot: () => snapshot });
  const task = runtime.run({ request: '生产 50 套 CP-1' });
  assert.equal(task.input.quantity, 50);
  assert.equal(task.input.product_code, 'CP-1');
  assert.equal(task.result.materials[0].required, 100);
  assert.equal(task.status, 'awaiting_approval');
  assert.equal(task.approval.writes_to_feishu, false);
  assert.equal(task.steps.at(-1).status, 'waiting_approval');
  assert.ok(task.result.purchase_quotes.length > 0);
  assert.ok(task.result.finance.total_estimate > 0);
  const reloaded = new TaskRuntime({ dataDir: testDir, getSnapshot: () => snapshot });
  assert.equal(reloaded.list()[0].id, task.id);
  const approved = reloaded.approve(task.id, '测试批准');
  assert.equal(approved.status, 'approved_local_only');
  assert.equal(approved.approval.writes_to_feishu, false);
  console.log('task-runtime tests: 12 assertions passed');
} finally {
  fs.rmSync(testDir, { recursive: true, force: true });
}
