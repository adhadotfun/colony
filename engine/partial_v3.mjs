import { readFileSync, writeFileSync } from 'node:fs';
import { spearman, bootstrapCI } from '/data/workspace/output/colony/engine/stats.mjs';
const scored = JSON.parse(readFileSync('out/scored_v3.json','utf8'));
const ds = JSON.parse(readFileSync('data/snapshots_v3.json','utf8'));
const byTok = new Map(ds.tokens.map(t=>[t.token,t]));
function rank(xs){const idx=xs.map((v,i)=>[v,i]).sort((a,b)=>a[0]-b[0]);const r=new Array(xs.length);let i=0;
 while(i<idx.length){let j=i;while(j+1<idx.length&&idx[j+1][0]===idx[i][0])j++;const avg=(i+j)/2+1;for(let k=i;k<=j;k++)r[idx[k][1]]=avg;i=j+1;}return r;}
// residualize y on predictors X by OLS on ranks
function resid(y, Xs){
 const n=y.length, p=Xs.length;
 const X=[]; for(let i=0;i<n;i++){const row=[1];for(const c of Xs)row.push(c[i]);X.push(row);}
 const m=p+1; const A=Array.from({length:m},()=>new Array(m).fill(0)); const b=new Array(m).fill(0);
 for(let i=0;i<n;i++){for(let a=0;a<m;a++){b[a]+=X[i][a]*y[i];for(let c=0;c<m;c++)A[a][c]+=X[i][a]*X[i][c];}}
 for(let c=0;c<m;c++){let piv=c;for(let r2=c+1;r2<m;r2++)if(Math.abs(A[r2][c])>Math.abs(A[piv][c]))piv=r2;
  [A[c],A[piv]]=[A[piv],A[c]];[b[c],b[piv]]=[b[piv],b[c]];
  for(let r2=0;r2<m;r2++){if(r2===c||A[c][c]===0)continue;const f=A[r2][c]/A[c][c];for(let k=c;k<m;k++)A[r2][k]-=f*A[c][k];b[r2]-=f*b[c];}}
 const beta=b.map((v,i)=>A[i][i]===0?0:v/A[i][i]);
 return y.map((v,i)=>v-X[i].reduce((s,xv,k)=>s+xv*beta[k],0));
}
const out={};
for(const k of [3,7,14]){
 const rows=[];
 for(const r of scored){const s=byTok.get(r.token).snapshots;const a=s[r.epoch],b2=s[r.epoch+k];
  if(!a||!b2||a.holder_count<10)continue;rows.push({...r,fwd:(b2.holder_count-a.holder_count)/a.holder_count});}
 const use=rows.filter(r=>r.pe_full!==null);
 const mk=(rs,field)=>{
  const g=rank(rs.map(r=>r.growth)), sl=rank(rs.map(r=>r.sell));
  const w=rank(rs.map(r=>r[field])), y=rank(rs.map(r=>r.fwd));
  const rw=resid(w,[g,sl]), ry=resid(y,[g,sl]);
  return spearman(rw,ry);
 };
 const cluster=(rs)=>{const m=new Map();for(const r of rs){if(!m.has(r.token))m.set(r.token,[]);m.get(r.token).push(r);}return [...m.values()];};
 out['k'+k]={
  arm_b_partial:+mk(rows,'pe_nogrowth').toFixed(3),
  arm_b_partial_ci:bootstrapCI(cluster(rows),rs=>rs.length>20?mk(rs,'pe_nogrowth'):null),
  arm_a_partial:+mk(use,'pe_full').toFixed(3),
  arm_a_partial_ci:bootstrapCI(cluster(use),rs=>rs.length>20?mk(rs,'pe_full'):null),
 };
}
writeFileSync('out/partial_v3.json',JSON.stringify(out,null,2));
console.log(JSON.stringify(out,null,2));
