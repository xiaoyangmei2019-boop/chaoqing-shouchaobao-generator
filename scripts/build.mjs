import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const sourceDir = path.join(root, 'src');
const target = path.join(root, 'index.html');
const modules = [
  'core.js',
  'image-work.js',
  'storage.js',
  'api.js',
  'gallery.js',
  'references.js',
  'tasks.js',
  'events.js',
  'updates.js',
];

let html = fs.readFileSync(target, 'utf8');
const script = '(()=>{ "use strict";\n'
  + modules.map((name) => `\n// ===== ${name} =====\n${fs.readFileSync(path.join(sourceDir, name), 'utf8')}`).join('\n')
  + '\n})();';

// 在写回 HTML 前先检查合并后的 JavaScript 语法。
new Function(script);

if (!/<script>[\s\S]*?<\/script>/.test(html)) {
  throw new Error('index.html 中没有找到可替换的主脚本。');
}

html = html.replace(/<script>[\s\S]*?<\/script>/, `<script>\n${script}\n</script>`);
const design = '<style id="workbench-design">\n' + fs.readFileSync(path.join(sourceDir, 'design.css'), 'utf8') + '\n</style>';
html = /<style id="workbench-design">[\s\S]*?<\/style>/.test(html)
  ? html.replace(/<style id="workbench-design">[\s\S]*?<\/style>/, design)
  : html.replace('</head>', design + '\n</head>');
// Hash the complete artifact without its own version tag; unchanged builds stay stable.
html = html.replace(/<meta name="app-version" content="[^"]*">\n?/g, '');
const digest = createHash('sha256').update(html).digest('hex').slice(0, 12);
const version = 'v-' + digest;
html = html.replace('</head>', `<meta name="app-version" content="${version}">\n</head>`);
fs.writeFileSync(target, html);
fs.writeFileSync(path.join(root, 'server', 'frontend-version.json'), JSON.stringify({ version }) + '\n');
console.log(`已生成 index.html（${Buffer.byteLength(html)} 字节，${modules.length} 个源码模块）。`);
