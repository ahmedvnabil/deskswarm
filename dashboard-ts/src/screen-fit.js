/** First-party inline viewer sizing; never changes a view-only desktop. */
import UI from './app/ui.js';
let fill = false;
let lastRatio = 0;
function sync() {
  if (!UI.rfb) return;
  UI.rfb.scaleViewport = true;
  UI.rfb.resizeSession = fill && !UI.rfb.viewOnly;
  const canvas = document.querySelector('#noVNC_container canvas');
  if (canvas?.width && canvas?.height) {
    const ratio = canvas.width / canvas.height;
    if (ratio !== lastRatio) {
      lastRatio = ratio;
      parent.postMessage({type:'deskswarm:screen-ratio',ratio},location.origin);
    }
  }
}
addEventListener('message', event => {
  if (event.source !== parent || event.origin !== location.origin || event.data?.type !== 'deskswarm:screen-fit') return;
  fill = event.data.fill === true;
  sync();
});
const timer = setInterval(sync, 500);
addEventListener('pagehide',()=>clearInterval(timer),{once:true});
