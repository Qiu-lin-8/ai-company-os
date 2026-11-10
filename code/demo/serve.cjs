const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const host = '127.0.0.1';
const port = 8765;
const root = __dirname;

const routes = new Map([
  ['/', 'department-workbench.html'],
  ['/department-workbench.html', 'department-workbench.html'],
  ['/workflow-demo.html', 'workflow-demo.html'],
  ['/index.html', 'index.html'],
]);

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, `http://${host}:${port}`).pathname;
  const fileName = routes.get(pathname);

  if (!fileName) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  const filePath = path.join(root, fileName);
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Unable to read page');
      return;
    }

    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(content);
  });
});

server.listen(port, host, () => {
  console.log(`AI Company OS demo: http://${host}:${port}`);
});
