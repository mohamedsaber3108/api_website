import { GET as getCatalog } from '../../../catalog/route';

export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{slug:string[]}> }) {
  const {slug}=await context.params;
  const id=slug.join('/');
  const response=await getCatalog();
  const body=await response.json() as {models:Array<{id:string}>;updatedAt:string;source:string};
  const model=body.models.find(m=>m.id===id);
  if(!model) return Response.json({error:{code:'model_not_found',message:'Model not found in current catalog'}},{status:404});
  return Response.json({data:model,meta:{updated_at:body.updatedAt,source:body.source}},{headers:{'Cache-Control':'public, max-age=300','Access-Control-Allow-Origin':'*'}});
}
