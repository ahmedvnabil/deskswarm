/** Trusted first-party panel bridge. Only the parent may route or activate a view. */
(() => {
  document.addEventListener('invalid',event=>{
    let parent=event.target.closest?.('details');while(parent){parent.open=true;parent=parent.parentElement?.closest('details');}
  },true);
  const embedded = new URLSearchParams(location.search).get('embedded') === '1';
  if (!embedded || window.parent === window) return;
  document.documentElement.dataset.embedded = 'true';
  document.documentElement.dataset.panelActive = 'true';
  const paths = new Set(['/', '/agents', '/manage', '/settings/connections', '/settings/cloudflare']);
  let previous = 0;
  function resize() {
    const height = Math.ceil(document.body.getBoundingClientRect().height + 8);
    if (height > 0 && height !== previous) {
      previous = height;
      parent.postMessage({type:'deskswarm:panel-height',height},location.origin);
    }
  }
  addEventListener('message',event=>{
    if(event.source!==parent || event.origin!==location.origin || event.data?.type!=='deskswarm:panel-active')return;
    document.documentElement.dataset.panelActive=event.data.active?'true':'false';
    if(event.data.active)requestAnimationFrame(()=>{previous=0;resize()});
  });
  document.addEventListener('click',event=>{
    const computer=event.target.closest?.('[data-open-computer]');
    if(computer && event.button===0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey){
      event.preventDefault();parent.postMessage({type:'deskswarm:open-computer',id:Number(computer.dataset.openComputer)},location.origin);return;
    }
    const link=event.target.closest?.('a[href]');
    if(!link || event.defaultPrevented || event.button!==0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || link.hasAttribute('download'))return;
    const url=new URL(link.href,location.href);
    if(url.origin!==location.origin || !paths.has(url.pathname))return;
    event.preventDefault();
    parent.postMessage({type:'deskswarm:navigate',path:url.pathname+url.search},location.origin);
  });
  document.addEventListener('htmx:beforeRequest',event=>{if(document.documentElement.dataset.panelActive==='false')event.preventDefault()});
  addEventListener('DOMContentLoaded',()=>{new ResizeObserver(resize).observe(document.body);resize()});
})();
