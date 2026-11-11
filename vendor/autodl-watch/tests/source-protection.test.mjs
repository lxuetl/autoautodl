import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
// 静态检查：浏览器适配器里按文字定位、会被点击或勾选的元素只有下面这些，均不会改动已有实例（含克隆源实例）。
// 新增按文字定位的点击目标时这里会失败，需要先确认它不是开关机、释放、重置、更换镜像等操作，再加入清单。
const source = fs.readFileSync(new URL('../src/adapters/autodl.mjs', import.meta.url), 'utf8');
const ALLOWED = new Map([
  ['更多', '实例列表中源实例所在行的菜单按钮，只用于打开“克隆实例”'],
  ['克隆实例', '“更多”菜单中的克隆入口，打开 AutoDL 的克隆对话框'],
  ['继续', '克隆对话框的继续，跳到克隆页（不下单）'],
  ['数据盘', '克隆对话框中是否同时复制数据盘（只影响新实例）'],
  ['按量计费', '创建页/克隆页的计费方式'],
  ['基础镜像', '创建页的镜像类型'],
  ['需要扩容', '创建页/克隆页为新实例扩容数据盘'],
  ['创建并开机', '创建页/克隆页提交新实例'],
  ['1', '资源列表分页'],
]);
test('适配器按文字定位的点击目标都在清单中，不含开机、关机、释放、重置等改动实例的操作', () => {
  const patterns = [
    /getByRole\(\s*'button'\s*,\s*\{\s*name\s*:\s*'([^']+)'/g,
    /getByText\(\s*'([^']+)'/g,
    /cloneClick\([^;]*?,\s*'([^']+)'\)/g,
    /\bradio(?:Label)?\(\s*'([^']+)'\)/g,
    /hasText\s*:\s*\/\^(?:\\s\*)?([^\\/$]+?)(?:\\s\*)?\$\//g,
    /hasText\s*:\s*'([^']+)'/g,
  ];
  const found = new Set(patterns.flatMap(p => [...source.matchAll(p)].map(m => m[1])));
  // “克隆给他人”只读取是否被选中，不点击；“克隆实例”也用于定位对话框。
  found.delete('克隆给他人');
  const unknown = [...found].filter(text => !ALLOWED.has(text));
  assert.deepEqual(unknown, [], '新的点击目标需要先确认不会改动实例：' + unknown.join('、'));
  for (const danger of ['开机', '关机', '无卡模式开机', '释放实例', '重置系统', '更换镜像', '保存镜像', '升降配置', '扩容数据盘', '缩容数据盘',
    '转包年包月', '转按量计费', '跨实例拷贝数据', '修改SSH密码', '重新创建', '确定', '确认', '去充值', '重新选择'])
    assert.equal(found.has(danger), false, danger);
});
test('克隆流程的点击只允许“更多”“克隆实例”“继续”三个文字完全相同的按钮', () => {
  assert.match(source, /if \(!\['更多', '克隆实例', '继续'\]\.includes\(label\)\) fail\('SOURCE_GUARD'/);
  assert.match(source, /if \(text !== label\) fail\('SOURCE_GUARD'/);
  // 程序不会代为点击弹窗中的按钮（包括 AutoDL 提示中的“继续”“确定”）。
  assert.doesNotMatch(source, /getByRole\('button',\s*\{\s*name:\s*'(?:确定|确认|我知道了|去充值)'/);
});
test('适配器不使用绕过点击清单检查的写法：鼠标坐标、派发事件、轻触、页面内点击、双引号文字定位、xpath 或 text= 选择器、除 Escape 外的按键',()=>{
  for (const [name, pattern] of [['page.mouse', /\.mouse\./], ['dispatchEvent', /dispatchEvent\(/], ['tap()', /\.tap\(/], ['页面内 click()', /evaluate[^;]*\.click\(\)/],
    ['双引号文字定位', /(?:getByText|getByRole|hasText)[^;]{0,40}"[^"]*"/], ['xpath', /xpath=|\/\/(?:button|span|div|a)\[/], ['text= 选择器', /['"]text=/], [':has-text', /:has-text\(/],
    ['除 Escape 外的按键', /\.press\(\s*'(?!Escape')/]])
    assert.doesNotMatch(source, pattern, name);
});
