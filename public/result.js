const $=id=>document.getElementById(id);
const data=JSON.parse(sessionStorage.getItem("sharespace-result")||"null");
if(!data){location.replace("/");}
else{
  const fmt=n=>n<1024*1024?`${(n/1024).toFixed(1)} KB`:`${(n/1024/1024).toFixed(1)} MB`;
  $("file-summary").innerHTML=`<div class="detail-row"><span>File name</span><strong></strong></div><div class="detail-row"><span>Size</span><strong>${fmt(data.fileSize)}</strong></div><div class="detail-row"><span>Uploaded files</span><strong>${data.fileCount}</strong></div><div class="detail-row"><span>Format</span><strong>${data.isZip?"ZIP archive":data.mimeType}</strong></div>`;
  $("file-summary").querySelector("strong").textContent=data.fileName;
  $("share-url").value=data.shareUrl;$("code").textContent=data.downloadCode;$("downloads").textContent=data.downloadCount;
  $("qr").src=`/api/share/${encodeURIComponent(data.id)}/qr`;$("qr-download").href=$("qr").src;
  $("copy-link").onclick=async()=>{await navigator.clipboard.writeText(data.shareUrl);notice("Sharing link copied successfully.");};
  $("copy-code").onclick=async()=>{await navigator.clipboard.writeText(data.downloadCode);notice("Download code copied successfully.");};
  function notice(t){$("notice").textContent=t;$("notice").className="message";setTimeout(()=>$("notice").classList.add("hidden"),2500);}
  let end=data.expiresAt;
  async function tick(){const left=Math.max(0,end-Math.floor(Date.now()/1000));$("countdown").textContent=`${String(Math.floor(left/60)).padStart(2,"0")}:${String(left%60).padStart(2,"0")}`;if(!left){$("revoke").disabled=true;$("countdown").textContent="Expired";} }
  tick();setInterval(tick,1000);
  async function refresh(){try{const r=await fetch(`/api/share/${data.id}/status`);if(!r.ok){$("countdown").textContent="Unavailable";$("revoke").disabled=true;return;}const s=await r.json();$("downloads").textContent=s.downloadCount;end=s.expiresAt;}catch{}}
  setInterval(refresh,5000);
  $("revoke").onclick=async()=>{if(!confirm("Revoke this share now? All three access methods will stop working."))return;const r=await fetch(`/api/share/${data.id}/revoke`,{method:"POST"});if(r.ok){$("countdown").textContent="Revoked";$("revoke").disabled=true;notice("Share revoked. All access methods are now invalid.");}else notice("Could not revoke this share.");};
}
