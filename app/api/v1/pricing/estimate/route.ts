import snapshot from '../../../../../data/catalog-snapshot.json';
import fxSnapshot from '../../../../../data/fx-snapshot.json';
import { GET as getCatalog } from '../../../catalog/route';
import { GET as getFx } from '../../../fx/route';

export const dynamic='force-dynamic';
export async function GET(request:Request){
  const url=new URL(request.url);
  const modelId=url.searchParams.get('model')||'';
  const currency=(url.searchParams.get('currency')||'USD').toUpperCase();
  const input=Number(url.searchParams.get('input_tokens')||0);
  const output=Number(url.searchParams.get('output_tokens')||0);
  const requests=Number(url.searchParams.get('requests')||1);
  if(!modelId||!['USD','EGP','SAR','AED','EUR'].includes(currency)||[input,output,requests].some(v=>!Number.isSafeInteger(v)||v<0||v>1_000_000_000))return Response.json({error:{code:'invalid_parameters',message:'Pass model, currency, input_tokens, output_tokens, and requests'}},{status:400});
  const [catalogResponse,fxResponse]=await Promise.all([getCatalog(),getFx()]);
  const catalog=await catalogResponse.json() as typeof snapshot;
  const fx=await fxResponse.json() as typeof fxSnapshot;
  const model=catalog.models.find(m=>m.id===modelId);
  if(!model)return Response.json({error:{code:'model_not_found',message:'Model not found'}},{status:404});
  if(model.input===null||model.output===null)return Response.json({error:{code:'variable_price',message:'This model has variable pricing; request a quote from the provider'}},{status:422});
  const usd=requests*(input*model.input+output*model.output)/1_000_000;
  const rate=fx.rates[currency as keyof typeof fx.rates];
  return Response.json({model:model.id,estimate:{amount:+(usd*rate).toFixed(6),currency,usd:+usd.toFixed(6),requests,input_tokens:input,output_tokens:output},meta:{model_prices_updated_at:catalog.updatedAt,fx_updated_at:fx.updatedAt,display_only:true,excludes:'platform fees, taxes, cache/image/audio/tool/routing charges'}},{headers:{'Cache-Control':'public, max-age=300','Access-Control-Allow-Origin':'*'}});
}
