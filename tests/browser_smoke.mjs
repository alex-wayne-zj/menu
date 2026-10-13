/** Real HTTPS UI check. Requires explicit URL and a root-readable credential file.
 * Creates only uniquely named temporary dishes/records, and removes them in finally.
 * Does not register the actual friend's account or reset a real user's password.
 */
import {chromium, expect} from '../frontend/node_modules/@playwright/test/index.mjs';
import {readFileSync, mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const url = process.env.MENU_E2E_URL;
const credentialFile = process.env.MENU_TEST_CREDENTIALS;
if (!url || !credentialFile) throw Error('Set MENU_E2E_URL and MENU_TEST_CREDENTIALS explicitly.');
const credentials = JSON.parse(readFileSync(credentialFile, 'utf8'));
const root = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(root + 'artifacts', {recursive:true});
const browser = await chromium.launch({headless:true,slowMo:60});
const context = await browser.newContext({viewport:{width:375,height:812}});
const page = await context.newPage();
const errors = [];
const testName = '验收临时菜-' + Date.now();
const createdDishes = [], createdRecords = [];
page.on('pageerror', error => errors.push(error.message));
page.on('dialog', dialog => dialog.accept());
const origin = new URL(url).origin;
async function request(path, method='GET', data) {
  const r = await context.request.fetch(origin + '/menu/api' + path, {
    method, data, headers:{Origin:origin},
  });
  assert.equal(r.ok(),true,`${method} ${path} returned ${r.status()}`);
  return await r.json();
}
async function narrow() {
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'horizontal overflow');
}
const dialog = () => page.getByRole('dialog');
const close = () => dialog().getByRole('button',{name:'关闭弹窗'}).click();
try {
  await page.goto(url,{waitUntil:'networkidle'});
  await expect(page.getByRole('button',{name:'登录',exact:true})).toBeVisible();
  await narrow();
  await page.getByRole('button',{name:'有邀请码？创建账户'}).click();
  await expect(page.getByLabel('邀请码',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'已有账户，去登录'}).click();
  await page.screenshot({path:root+'artifacts/login-mobile.png',fullPage:true});
  await page.getByLabel('用户名',{exact:true}).fill(credentials.username);
  await page.getByLabel('密码',{exact:true}).fill(credentials.password);
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('heading',{name:'今天想吃什么？'})).toBeVisible();
  await expect(page.locator('.dish-card')).toHaveCount(6);
  await narrow();
  await page.getByPlaceholder('搜索菜名，或一种食材…').fill('西兰花');
  await expect(page.locator('.dish-card')).toHaveCount(1);
  await page.getByRole('button',{name:'清空搜索'}).click();
  await page.locator('.categories').getByRole('button',{name:'肉菜',exact:true}).click();
  await expect(page.locator('.dish-card')).toHaveCount(2);
  await page.locator('.categories').getByRole('button',{name:'全部',exact:true}).click();
  await page.locator('.dish-card').filter({has:page.getByRole('button',{name:'土豆烧鸡',exact:true})}).getByRole('button',{name:'＋ 加入'}).click();
  await page.getByRole('button',{name:'帮我挑 ↗'}).click();
  await expect(dialog().getByText(/帮你补|补一道素菜|素菜优先/)).toBeVisible();
  await expect(dialog().getByText(/的菜谱 · 素菜/)).toBeVisible();
  const first = await dialog().locator('h3').textContent();
  await dialog().getByRole('button',{name:'换一道'}).click();
  assert.notEqual(await dialog().locator('h3').textContent(),first);
  await dialog().getByRole('button',{name:'加入今天想吃',exact:true}).click();
  await page.reload({waitUntil:'networkidle'});
  await expect(page.locator('.cart-bar')).toContainText('今天想吃 · 2 道');
  await page.getByRole('button',{name:'查看菜单 →'}).click();
  await narrow();
  await expect(dialog().locator('.cart-item')).toHaveCount(2);
  await dialog().getByRole('button',{name:'清空选择'}).click();
  await close();
  await page.getByRole('button',{name:'＋ 新增菜品'}).click();
  await dialog().getByLabel('菜名',{exact:true}).fill(testName);
  await dialog().getByLabel('配料说明',{exact:true}).fill('测试配料原文，保留快照。');
  await dialog().getByLabel('荤素标记').selectOption('vegetable');
  await dialog().locator('input[type=file]').setInputFiles({name:'fake.jpg',mimeType:'image/jpeg',buffer:Buffer.from('not an image')});
  await dialog().getByRole('button',{name:'保存菜谱'}).click();
  await expect(dialog().getByRole('alert').first()).toBeVisible();
  await expect(dialog().getByLabel('菜名',{exact:true})).toHaveValue(testName);
  await dialog().locator('input[type=file]').setInputFiles(root+'assets/examples/tomato-eggs.webp');
  await dialog().getByRole('button',{name:'保存菜谱'}).click();
  await expect(dialog().getByRole('heading',{name:testName,exact:true})).toBeVisible();
  const testDish = (await request('/dishes')).find(d=>d.name===testName);
  assert.ok(testDish);createdDishes.push(testDish.id);
  await dialog().getByRole('button',{name:'加入今天想吃',exact:true}).click();
  await close();
  await page.getByRole('button',{name:'查看菜单 →'}).click();
  // Check the synthetic test date is unused; never replace a real record.
  const date = '1901-01-01';
  assert.equal((await request('/records')).some(r=>r.owner_id===testDish.owner_id&&r.date===date),false,'test date occupied');
  await dialog().getByLabel('做菜日期').fill(date);
  await dialog().getByRole('button',{name:'生成菜单',exact:true}).click();
  await expect(dialog().getByRole('heading',{name:'这一餐的记录'})).toBeVisible();
  const saved = (await request('/records')).find(r=>r.owner_id===testDish.owner_id&&r.date===date);
  assert.ok(saved);createdRecords.push(saved.id);
  await expect(dialog()).toContainText('测试配料原文，保留快照。');
  await dialog().getByRole('button',{name:'编辑记录',exact:true}).click();
  assert.equal((await request('/records')).some(r=>r.owner_id===testDish.owner_id&&r.date==='1901-01-02'),false,'test date occupied');
  await dialog().getByLabel('做菜日期').fill('1901-01-02');
  await dialog().getByRole('button',{name:'保存记录修改'}).click();
  await expect(dialog()).toContainText('1901-01-02');
  await close();
  await page.getByRole('button',{name:'我的菜谱',exact:true}).click();
  await page.locator('.dish-card').getByRole('button',{name:testName,exact:true}).click();
  await dialog().getByRole('button',{name:'编辑菜品',exact:true}).click();
  await dialog().getByLabel('配料说明',{exact:true}).fill('修改后的新配料');
  await dialog().getByRole('button',{name:'保存菜谱'}).click();
  await expect(dialog()).toContainText('修改后的新配料');
  await close();
  await page.getByRole('button',{name:'饮食记录',exact:true}).click();
  await page.locator('.history-row').filter({hasText:testName}).click();
  await expect(dialog()).toContainText('测试配料原文，保留快照。');
  await expect(dialog()).not.toContainText('修改后的新配料');
  await dialog().getByRole('button',{name:'删除记录'}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  createdRecords.length=0;
  await page.getByRole('button',{name:'我的菜谱',exact:true}).click();
  await page.locator('.dish-card').getByRole('button',{name:testName,exact:true}).click();
  await dialog().getByRole('button',{name:'编辑菜品',exact:true}).click();
  await dialog().getByRole('button',{name:'删除菜品'}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  createdDishes.length=0;
  await page.getByRole('button',{name:'选菜',exact:true}).click();
  await page.getByRole('button',{name:credentials.username,exact:true}).click();
  await dialog().getByText('账户管理',{exact:true}).click();
  await expect(dialog().getByText(credentials.friend_username+' · 待注册',{exact:true})).toBeVisible();
  await close();
  await narrow();
  await page.screenshot({path:root+'artifacts/menu-mobile.png',fullPage:true});
  await page.setViewportSize({width:1280,height:900});
  await narrow();
  await page.screenshot({path:root+'artifacts/menu-desktop.png',fullPage:true});
  await page.getByRole('button',{name:credentials.username,exact:true}).click();
  await dialog().getByRole('button',{name:'退出登录'}).click();
  await expect(page.getByRole('button',{name:'登录',exact:true})).toBeVisible();
  assert.deepEqual(errors,[],'browser JS errors');
  console.log('PASS real HTTPS mobile/desktop UI: auth, search, filters, random, cart restore, upload errors, CRUD, date history, snapshots, invitation view, logout.');
} catch (error) {
  await page.screenshot({path:root+'artifacts/browser-failure.png',fullPage:true});
  console.error('UI failure headings:',await page.locator('h1,h2').allTextContents());
  throw error;
} finally {
  for(const id of createdRecords) {
    try {await request('/records/'+id,'DELETE')} catch {console.error('Temporary test record cleanup failed:',id);process.exitCode=1;}
  }
  for(const id of createdDishes) {
    try {await request('/dishes/'+id,'DELETE')} catch {console.error('Temporary test dish cleanup failed:',id);process.exitCode=1;}
  }
  await browser.close();
}
