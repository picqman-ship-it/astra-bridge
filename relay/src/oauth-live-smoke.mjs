// Live end-to-end check of the Worker's own OAuth server (MCP_AUTH_MODE "static" only;
// in "access" mode these routes return 404). Runs authorize -> PKCE token -> MCP
// initialize/tools/list/get_config -> refresh rotation -> old refresh rejected.
//
//   ASTRA_RELAY_URL                required, must equal the Worker's OAUTH_ISSUER origin
//   ASTRA_OAUTH_OWNER_SECRET_FILE  default ~/.astra-bridge/oauth-owner-secret (file holding OAUTH_OWNER_SECRET)
//   ASTRA_SMOKE_EXPECTED_TOOLS     default 27 (tools exposed on /mcp with trusted terminal, no GUI tools)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
const relayUrl=process.env.ASTRA_RELAY_URL?.trim();
if(!relayUrl){console.error('ASTRA_RELAY_URL is required (https://<your-worker>.<your-subdomain>.workers.dev).');process.exit(2);}
const origin=new URL(relayUrl).origin;
const resource=origin+'/mcp';
const clientId='https://chatgpt.com/oauth/client.json';
const redirectUri='https://chatgpt.com/connector_platform_oauth_redirect';
const ownerSecretFile=process.env.ASTRA_OAUTH_OWNER_SECRET_FILE||path.join(os.homedir(),'.astra-bridge','oauth-owner-secret');
const expectedTools=Number(process.env.ASTRA_SMOKE_EXPECTED_TOOLS||27);
let owner;
try{owner=fs.readFileSync(ownerSecretFile,'utf8').trim();}catch(err){console.error(`Cannot read the OAuth owner secret file ${ownerSecretFile} (${err.code||err.message}). Set ASTRA_OAUTH_OWNER_SECRET_FILE.`);process.exit(2);}
const b64u=b=>Buffer.from(b).toString('base64url');
const verifier=b64u(crypto.randomBytes(48));
const challenge=b64u(crypto.createHash('sha256').update(verifier).digest());
const state=b64u(crypto.randomBytes(18));
const scope='astra.read astra.write astra.control';
const q=new URLSearchParams({response_type:'code',client_id:clientId,redirect_uri:redirectUri,state,scope,code_challenge:challenge,code_challenge_method:'S256',resource});
let res=await fetch(origin+'/oauth/authorize?'+q,{redirect:'manual'});
if(res.status!==200)throw new Error('authorize GET '+res.status);
console.log('PASS authorize GET');
const form=new URLSearchParams(q);
form.set('owner_secret',owner);
form.set('decision','approve');
for(const s of ['astra.read','astra.write','astra.control'])form.append('granted_scope',s);
res=await fetch(origin+'/oauth/authorize',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','origin':origin},body:form,redirect:'manual'});
if(res.status!==302)throw new Error('authorize POST '+res.status);
const loc=new URL(res.headers.get('location'));
if(loc.origin+loc.pathname!==redirectUri||loc.searchParams.get('state')!==state||loc.searchParams.get('iss')!==origin)throw new Error('redirect/state/iss');
const code=loc.searchParams.get('code');if(!code)throw new Error('no code');
console.log('PASS authorize POST code/state/iss');
const tokenBody=new URLSearchParams({grant_type:'authorization_code',code,client_id:clientId,redirect_uri:redirectUri,code_verifier:verifier,resource});
res=await fetch(origin+'/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:tokenBody});
if(res.status!==200)throw new Error('token '+res.status);
let tokens=await res.json();if(!tokens.access_token||!tokens.refresh_token)throw new Error('token incomplete');
console.log('PASS PKCE token exchange');
async function mcp(id,method,params={}){
  const rr=await fetch(resource,{method:'POST',headers:{authorization:'Bearer '+tokens.access_token,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})});
  const txt=await rr.text();if(!rr.ok)throw new Error('mcp '+method+' '+rr.status);
  try{return JSON.parse(txt)}catch{const m=txt.match(/data:\s*(\{.*\})/s);if(!m)throw new Error('mcp parse');return JSON.parse(m[1])}
}
let x=await mcp(1,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'oauth-live-check',version:'1'}});
if(x.result?.serverInfo?.name!=='astra-bridge-relay')throw new Error('init');
console.log('PASS OAuth MCP initialize');
x=await mcp(2,'tools/list',{});
const tools=x.result?.tools??[];
if(tools.length!==expectedTools)throw new Error('tools '+tools.length);
if(!tools.every(t=>Array.isArray(t.securitySchemes)&&t.securitySchemes.some(s=>s.type==='oauth2')))throw new Error('securitySchemes');
console.log('PASS OAuth tools/list '+expectedTools);
x=await mcp(3,'tools/call',{name:'get_config',arguments:{}});
const cfg=(x.result?.content??[]).map(v=>v.text??'').join('\n');
if(!cfg.includes('0.3.0'))throw new Error('get_config');
console.log('PASS OAuth tools/call get_config');
const oldRefresh=tokens.refresh_token;
const refreshBody=new URLSearchParams({grant_type:'refresh_token',refresh_token:oldRefresh,client_id:clientId,resource});
res=await fetch(origin+'/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:refreshBody});
if(res.status!==200)throw new Error('refresh '+res.status);
tokens=await res.json();
if(!tokens.access_token||!tokens.refresh_token||tokens.refresh_token===oldRefresh)throw new Error('refresh rotation');
console.log('PASS refresh rotation');
res=await fetch(origin+'/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:refreshBody});
if(res.status===200)throw new Error('old refresh accepted');
console.log('PASS old refresh rejected');
console.log('LIVE_OAUTH_MCP_OK');
