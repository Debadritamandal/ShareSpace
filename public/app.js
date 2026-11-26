const $ = id => document.getElementById(id);
let selected = [];
const filesInput = $("files"), drop = $("dropzone");
const fmt = n => n < 1024*1024 ? `${(n/1024).toFixed(1)} KB` : `${(n/1024/1024).toFixed(1)} MB`;
function showError(id, msg) { $(id).textContent = msg; $(id).classList.remove("hidden"); }
function hideError(id) { $(id).classList.add("hidden"); }
function renderFiles() {
  $("file-list").innerHTML = "";
  selected.forEach((f,i) => {
    const row = document.createElement("div"); row.className = "file-item";
    const name = document.createElement("span"); name.textContent = f.name;
    const size = document.createElement("span"); size.textContent = fmt(f.size);
    const remove = document.createElement("button"); remove.textContent = "×"; remove.className = "button secondary"; remove.style.padding = "3px 9px";
    remove.addEventListener("click", () => { selected.splice(i,1); renderFiles(); });
    row.append(name,size,remove); $("file-list").append(row);
  });
}
function acceptFiles(list) { selected = [...selected, ...Array.from(list)].slice(0,30); renderFiles(); }
filesInput.addEventListener("change", e => { acceptFiles(e.target.files); filesInput.value = ""; });
["dragenter","dragover"].forEach(ev => drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.add("drag")}));
["dragleave","drop"].forEach(ev => drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.remove("drag")}));
drop.addEventListener("drop",e=>acceptFiles(e.dataTransfer.files));
$("upload-btn").addEventListener("click", () => {
  hideError("upload-error");
  if (!selected.length) return showError("upload-error","Please select at least one file.");
  if (selected.some(f=>f.size>500*1024*1024)) return showError("upload-error","Each file must be 500 MB or smaller.");
  const data = new FormData(); selected.forEach(f=>data.append("files",f));
  const xhr = new XMLHttpRequest(); xhr.open("POST","/api/upload");
  $("upload-btn").disabled = true; $("progress-wrap").classList.remove("hidden");
  xhr.upload.onprogress = e => { if(e.lengthComputable){const p=Math.round(e.loaded/e.total*100);$("progress-bar").style.width=p+"%";$("progress-value").textContent=p+"%";} };
  xhr.onload = () => {
    $("upload-btn").disabled = false;
    let result; try { result=JSON.parse(xhr.responseText); } catch { result={error:"Unexpected server response."}; }
    if(xhr.status<200||xhr.status>=300){$("progress-wrap").classList.add("hidden");return showError("upload-error",result.error||"Upload failed.");}
    sessionStorage.setItem("sharespace-result",JSON.stringify(result));
    location.href="/result.html";
  };
  xhr.onerror=()=>{$("upload-btn").disabled=false;$("progress-wrap").classList.add("hidden");showError("upload-error","Network error. Please try again.");};
  xhr.send(data);
});
$("open-link").addEventListener("click",()=>{hideError("download-error");try{const u=new URL($("link-input").value.trim());if(u.protocol!=="http:"&&u.protocol!=="https:")throw 0;if(!u.pathname.startsWith("/s/"))throw 0;location.href=u.href;}catch{showError("download-error","Enter a valid ShareSpace sharing link.");}});
$("code-input").addEventListener("input",e=>e.target.value=e.target.value.replace(/\D/g,"").slice(0,6));
$("code-btn").addEventListener("click",async()=>{
  hideError("download-error");const code=$("code-input").value;
  if(!/^\d{6}$/.test(code))return showError("download-error","Enter exactly six digits.");
  $("code-btn").disabled=true;$("code-btn").textContent="Checking…";
  try{const r=await fetch("/api/download/code",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code})});const d=await r.json();if(!r.ok)throw new Error(d.error);location.href=d.url;}
  catch(e){showError("download-error",e.message||"Could not validate this code.");}
  finally{$("code-btn").disabled=false;$("code-btn").innerHTML='Find my file <span>→</span>';}
});
