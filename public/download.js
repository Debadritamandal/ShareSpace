const token=location.pathname.split("/").filter(Boolean).pop();
const $=id=>document.getElementById(id);
const fmt=n=>n<1024*1024?`${(n/1024).toFixed(1)} KB`:`${(n/1024/1024).toFixed(1)} MB`;
function fail(msg){$("download-error").textContent=msg;$("download-error").classList.remove("hidden");$("download-button").classList.add("disabled");}
(async()=>{
 try{
  const r=await fetch(`/api/share/${encodeURIComponent(token)}`);const d=await r.json();if(!r.ok)throw new Error(d.error);
  const rows=[["File name",d.fileName],["File size",fmt(d.fileSize)],["File type",d.mimeType],["Number of files",d.fileCount]];
  $("download-details").innerHTML="";
  rows.forEach(([k,v])=>{const row=document.createElement("div");row.className="detail-row";const a=document.createElement("span"),b=document.createElement("strong");a.textContent=k;b.textContent=v;row.append(a,b);$("download-details").append(row);});
  $("download-button").href=`/api/download/${encodeURIComponent(token)}`;$("download-button").classList.remove("disabled");
  let expires=d.expiresAt;
  function tick(){const n=Math.max(0,expires-Math.floor(Date.now()/1000));$("countdown").textContent=n?`${Math.floor(n/60)}m ${n%60}s`:"Expired";if(!n)$("download-button").classList.add("disabled");}
  tick();setInterval(tick,1000);
 }catch(e){fail(e.message||"This share is invalid, expired, or unavailable.");$("download-details").textContent="The file may have expired or been revoked.";}
})();
