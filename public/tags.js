const $ = (s)=>document.querySelector(s);
const toast=(m)=>{const t=$('#toast');t.textContent=m;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),1500);};

const themeToggle=$('#themeToggle');
(function(){
  const saved=localStorage.getItem('theme');
  if(saved)document.documentElement.setAttribute('data-theme',saved);
  themeToggle?.addEventListener('click',()=>{
    const cur=document.documentElement.getAttribute('data-theme')||'light';
    const next=cur==='light'?'dark':'light';
    document.documentElement.setAttribute('data-theme',next);
    localStorage.setItem('theme',next);
  });
})();

const mapForm=$('#mapForm');
const cidr=$('#cidr');
const appName=$('#appName');
const owner=$('#owner');
const env=$('#env');
const notes=$('#notes');
const formHint=$('#formHint');
const search=$('#search');
const mapBody=$('#mapBody');
const countInfo=$('#countInfo');
const exportBtn=$('#exportBtn');
const importFile=$('#importFile');

function esc(s){return String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&#039;");}
function validNet(s){return /^(\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?$/.test(String(s).trim());}

async function listMappings(){const r=await fetch('/api/mappings');return r.json();}
async function createMapping(p){const r=await fetch('/api/mappings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});if(!r.ok)throw new Error('Create failed');return r.json();}
async function deleteMapping(id){const r=await fetch(`/api/mappings/${id}`,{method:'DELETE'});if(!r.ok)throw new Error('Delete failed');return r.json();}
async function updateMapping(id,p){const r=await fetch(`/api/mappings/${id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});if(!r.ok)throw new Error('Update failed');return r.json();}

let all=[];

function render(items){
  if(!items.length){mapBody.innerHTML=`<tr><td colspan="3" class="muted">No mappings yet.</td></tr>`;countInfo.textContent='0';return;}
  countInfo.textContent=`${items.length} mapping${items.length>1?'s':''}`;
  mapBody.innerHTML=items.map(it=>`
  <tr data-id="${it.id}">
    <td><span class="pill">${esc(it.cidr)}</span></td>
    <td>
      ${(it.applications||[]).map(a=>`<div><span class="pill">App: ${esc(a.name)}</span>
      ${a.owner?`<span class="pill">Owner:${esc(a.owner)}</span>`:''}
      ${a.env?`<span class="pill">Env:${esc(a.env)}</span>`:''}
      ${a.notes?`<span class="pill">Notes</span>`:''}</div>`).join('')||'<span class="muted">—</span>'}
    </td>
    <td>
      <button class="btn" data-add="${it.id}">+ App</button>
      <button class="btn ghost" data-del="${it.id}">Delete</button>
    </td>
  </tr>`).join('');

  mapBody.querySelectorAll('[data-del]').forEach(btn=>btn.addEventListener('
