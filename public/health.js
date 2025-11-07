// health.js — unified Tufin connection health controller
(function initHealthBanner(){
  const banner = document.getElementById("tufinHealthBanner");
  const msg = document.getElementById("tufinHealthMsg");
  const retry = document.getElementById("healthRetry");
  if (!banner || !msg) return;

  let es = null;
  function setBanner(h){ banner.style.display = h.status === "DOWN" ? "block" : "none"; msg.textContent = h.lastError ? `(${h.lastError.message})` : ""; }

  function startStream(){
    try{
      if (es) es.close();
      es = new EventSource("/api/health/stream");
      es.onmessage = (e)=>{ try{ setBanner(JSON.parse(e.data)); }catch{} };
      es.onerror = ()=>{ if (es) es.close(); es = null; setTimeout(startStream, 15000); };
    }catch{}
  }
  startStream();

  retry?.addEventListener("click", async ()=>{ try{ await fetch("/api/health/recheck"); }catch{} });
  window.addEventListener("beforeunload", ()=>{ if (es) { es.close(); es = null; } });
})();
