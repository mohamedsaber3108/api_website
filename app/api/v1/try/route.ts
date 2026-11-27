import { discardBody } from '../../../../lib/server/http';
import { publicLimit } from '../../../../lib/server/ratelimit';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try { return await handleTry(request); } finally { await discardBody(request); }
}
async function handleTry(request: Request) {
  const origin = request.headers.get('origin');
  if (origin) { try {if (new URL(origin).host !== new URL(request.url).host) return Response.json({error:'Cross-origin requests are not allowed.'},{status:403});} catch {return Response.json({error:'Invalid origin.'},{status:403});} }
  // Unauthenticated and relays provider calls of up to 45 s: 5 per minute and 40 per hour per IP.
  const limited = (await publicLimit(request, 'try-min', 5, 60)) ?? (await publicLimit(request, 'try-hour', 40, 3600));
  if (limited) return limited;
  if (Number(request.headers.get('content-length')||0)>16000) return Response.json({error:'Request too large.'},{status:413});
  const key = request.headers.get('authorization')?.match(/^Bearer (sk-or-[A-Za-z0-9_-]{8,})$/)?.[1];
  if (!key) return Response.json({error:'Provide an OpenRouter API key in the Authorization header.'},{status:401});
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({error:'Invalid JSON.'},{status:400}); }
  const data = body as {model?:unknown;prompt?:unknown};
  if (typeof data?.model !== 'string' || !/^[a-zA-Z0-9._:\/-]{3,150}$/.test(data.model) || typeof data.prompt !== 'string' || !data.prompt.trim() || data.prompt.length>4000) return Response.json({error:'A model and a prompt of up to 4000 characters are required.'},{status:400});
  const controller = new AbortController();
  const timeout = setTimeout(()=>controller.abort(),45000);
  try {
    const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions',{
      method:'POST',signal:controller.signal,
      headers:{'Authorization':`Bearer ${key}`,'Content-Type':'application/json','HTTP-Referer':new URL(request.url).origin,'X-Title':'Wasl AI Playground'},
      body:JSON.stringify({model:data.model,messages:[{role:'user',content:data.prompt.trim()}],max_tokens:512,stream:false,usage:{include:true}})
    });
    const payload = await upstream.json().catch(()=>({})) as { model?: string; error?: { message?: string }; usage?: unknown; choices?: { message?: { content?: unknown } }[] };
    if (!upstream.ok) return Response.json({error:payload?.error?.message || `Provider returned ${upstream.status}.`,provider_status:upstream.status},{status:upstream.status >= 500 ? 502 : upstream.status,headers:{'Cache-Control':'no-store'}});
    const answer=payload?.choices?.[0]?.message?.content;
    return Response.json({model:payload?.model || data.model,answer:typeof answer==='string'?answer:Array.isArray(answer)?answer.filter((p:{type?:string;text?:string})=>p.type==='text').map((p:{text?:string})=>p.text||'').join('\n'):'',usage:payload?.usage || null},{headers:{'Cache-Control':'no-store'}});
  } catch(e) { return Response.json({error:e instanceof Error && e.name==='AbortError'?'The model timed out after 45 seconds.':'Could not reach OpenRouter.'},{status:502,headers:{'Cache-Control':'no-store'}}); }
  finally {clearTimeout(timeout);}
}
