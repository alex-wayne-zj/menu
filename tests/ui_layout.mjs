/** Mobile layout regressions, using fixture responses and a temporary loopback server.
 * No production credentials or data are accessed.
 */
import { chromium, webkit, expect } from '../frontend/node_modules/@playwright/test/index.mjs';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = resolve(root, 'frontend/dist');
const mime = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.webp':'image/webp','.webmanifest':'application/manifest+json'};
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const relative = path.replace(/^\/menu\/?/, '') || 'index.html';
    const file = resolve(dist, relative);
    if (!file.startsWith(dist + '/')) {res.writeHead(404).end();return;}
    const content = await readFile(file);
    res.writeHead(200, {'Content-Type':mime[extname(file)] || 'application/octet-stream'}).end(content);
  } catch {res.writeHead(404).end();}
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = process.env.MENU_LAYOUT_URL || `http://127.0.0.1:${server.address().port}/menu/`;
await mkdir(root+'artifacts', {recursive:true});
const user = {id:1,username:'chef',is_admin:false};
const names = ['番茄炒蛋','青椒肉丝','香菇西兰花配清炒时令蔬菜'];
const dishes = names.map((name,index)=>({id:index+1,owner_id:1,owner_name:'chef',name,category:index===1?'肉菜':'家常菜',kind:index===1?'meat':'vegetable',image_url:'/menu/icons/icon-192.png',ingredients:'番茄 2 个、鸡蛋 3 个、生抽适量、少许盐。',notes:'厨房小记',is_example:false,version:1}));
const record = {id:1,owner_id:1,owner_name:'chef',date:'2026-10-12',version:1,items:dishes.map(d=>({dish_id:d.id,source_user:d.owner_name,name:d.name,ingredients:d.ingredients,image_url:d.image_url,kind:d.kind}))};
const close = page=>page.getByRole('button',{name:'关闭弹窗'}).click();
async function noOverflow(page, label) {
  const result = await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll('body *')].filter(e=>{const r=e.getBoundingClientRect();return r.width && r.right>innerWidth+1 && getComputedStyle(e).position!=='fixed' && !e.closest('.categories');}).map(e=>e.className||e.tagName).slice(0,6)}));
  assert.ok(result.scroll<=result.width,`${label}: ${JSON.stringify(result)}`);
  const modal = page.getByRole('dialog');
  if(await modal.count())assert.equal(await modal.evaluate(e=>e.scrollWidth<=e.clientWidth+1),true,`${label}: modal horizontally scrolls`);
}
const engines = process.env.MENU_LAYOUT_BROWSER === 'chromium' ? [['chromium',chromium]] : [['chromium',chromium],['webkit',webkit]];
try {
  for (const [name,engine] of engines) {
    const browser = await engine.launch({headless:true});
    try {
      for (const width of [320,375,390,1280]) {
        const context = await browser.newContext({viewport:{width,height:844},isMobile:width<520,deviceScaleFactor:1});
        const page = await context.newPage();
        const errors=[];page.on('pageerror',e=>errors.push(e.message));
        let signedIn=true;
        await page.route('**/menu/api/**',async route=>{
          const path = new URL(route.request().url()).pathname.replace('/menu/api','');
          const value = path==='/auth/me'?{user}:path==='/dishes'?dishes:path==='/users'?[user,{id:2,username:'friend',is_admin:false}]:path==='/records'?[record]:[];
          await route.fulfill({status:path==='/auth/me'&&!signedIn?401:200,contentType:'application/json',body:JSON.stringify(value)});
        });
        await page.goto(base,{waitUntil:'networkidle'});
        await expect(page.locator('.dish-card')).toHaveCount(3);
        await expect(page.locator('.brand')).not.toContainText('SHI JI');
        await expect(page.locator('.account')).toHaveText('chef');
        await expect(page.locator('.footnote')).toContainText('认真吃饭，悠闲生活');
        await noOverflow(page,`${name} ${width} menu`);
        if(width<520){
          assert.ok(await page.locator('.ingredients-preview').first().evaluate(e=>parseFloat(getComputedStyle(e).fontSize))>=15);
          assert.ok(await page.locator('.source').first().evaluate(e=>parseFloat(getComputedStyle(e).fontSize))>=13);
        }
        await page.getByRole('button',{name:'查看番茄炒蛋配料'}).click();
        await expect(page.getByRole('button',{name:'关闭弹窗'})).toHaveText('关闭');
        await noOverflow(page,`${name} ${width} detail`);
        await page.getByRole('button',{name:'加入今天想吃',exact:true}).click();
        await close(page);
        await page.getByRole('button',{name:'查看菜单 →'}).click();
        await noOverflow(page,`${name} ${width} cart`);
        const date = page.getByLabel('做菜日期');
        if(width<520)assert.ok((await date.boundingBox()).width<=201,'cart date field too wide');
        await close(page);
        await page.getByRole('button',{name:'饮食记录',exact:true}).click();
        await expect(page.locator('.history-row')).toHaveCount(1);
        await noOverflow(page,`${name} ${width} history empty date`);
        await page.getByLabel('做菜日期').fill('2026-10-12');
        await noOverflow(page,`${name} ${width} history filled date`);
        if(width===375)await page.screenshot({path:root+`artifacts/history-${name}-375.png`,fullPage:true});
        await page.locator('.history-row').click();
        await page.getByRole('button',{name:'编辑记录',exact:true}).click();
        await noOverflow(page,`${name} ${width} record editor`);
        await close(page);
        const icon=page.locator('link[rel="apple-touch-icon"]');
        await expect(icon).toHaveAttribute('href','/menu/icons/apple-touch-icon.png?v=2');
        assert.ok((await page.locator('.account').boundingBox()).width>=80,'username entry too narrow');
        const response=await context.request.get(new URL(await icon.getAttribute('href'),base).href);
        assert.equal(response.status(),200);
        assert.equal(response.headers()['content-type'],'image/png');
        if(width===375){
          await page.getByRole('button',{name:'选菜',exact:true}).click();
          await page.screenshot({path:root+`artifacts/menu-${name}-375-large-font.png`,fullPage:true});
        }
        signedIn=false;await page.reload({waitUntil:'networkidle'});
        await expect(page.getByRole('button',{name:'登录',exact:true})).toBeVisible();
        await expect(page.locator('.brand')).not.toContainText('SHI JI');
        await noOverflow(page,`${name} ${width} login`);
        assert.deepEqual(errors,[]);
        console.log(`PASS ${name} ${width}px: menu/detail/cart/history/editor/login widths, larger font, labels and Apple icon.`);
        await context.close();
      }
    } finally {await browser.close();}
  }
} finally {await new Promise(resolve=>server.close(resolve));}
