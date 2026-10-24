/** One application shell; embedded views retain their own scripts and draft state. */
import type { Context } from 'hono';
import type { Env } from './http';
import { render } from './templates';
import { listComputers } from './machines';
export function pageView(c:Context<Env>,template:string,path:string){
  c.header('Cache-Control','no-store');
  c.header('Content-Security-Policy',"frame-ancestors 'self'");
  return c.html(c.req.query('embedded')==='1'
    ? render(template,{actor:c.get('actor'),computers:listComputers()})
    : render('index.html',{actor:c.get('actor'),computers:listComputers(),initial_panel:path}));
}
