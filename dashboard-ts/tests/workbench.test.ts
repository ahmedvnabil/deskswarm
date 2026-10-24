import {beforeEach,expect,test} from 'bun:test';
import {reset,get} from './harness';
beforeEach(reset);
test('every bookmarked application view renders the same shell and workspace below the preview without redirects',async()=>{
  for(const path of ['/agents','/manage','/settings/connections','/settings/cloudflare']){
    const response=await get(path);
    expect(response.status).toBe(200);expect(response.headers.get('location')).toBeNull();
    expect(response.text).toContain(`data-initial-panel="${path}"`);
    expect(response.text).toContain('id="workbench"');expect(response.text).toContain('id="nav-agents"');
    expect(response.text.indexOf('id="workbench"')).toBeGreaterThan(response.text.indexOf('class="screen-stage"'));
  }
});
test('embedded views have a shared local identity and bridge without recursively including another shell',async()=>{
  for(const path of ['/agents','/manage','/settings/connections','/settings/cloudflare']){
    const response=await get(path+'?embedded=1');expect(response.status).toBe(200);
    expect(response.text).toContain('/static/panels.css');expect(response.text).toContain('/static/panels.js');
    expect(response.text).not.toContain('id="workbench"');expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
  }
  const manage=await get('/manage?embedded=1');expect(manage.text).not.toContain('cdn.tailwindcss.com');expect(manage.text).not.toContain('unpkg.com');
  expect(manage.text).toContain('/static/vendor/htmx.min.js');expect(manage.text).toContain('/static/manage.css');
});
test('new panel assets are authenticated and cannot expose sibling vendor metadata or secrets',async()=>{
  for(const path of ['/static/panels.js','/static/panels.css','/static/manage.css','/static/vendor/htmx.min.js']){
    expect((await get(path)).status).toBe(200);expect((await get(path,{noCookie:true})).status).toBe(401);
  }
  expect((await get('/static/vendor/UPSTREAM.json')).status).toBe(404);
  expect((await get('/static/vendor/../../data/.agent-secret-key')).status).toBe(404);
});
