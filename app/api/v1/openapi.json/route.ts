export const dynamic = 'force-dynamic';

const err = { $ref: '#/components/schemas/Error' };
const errResponses = (codes: number[]) =>
  Object.fromEntries(codes.map(c => [String(c), { description: ({ 400: 'Invalid request', 401: 'Missing, invalid, expired, or revoked key', 402: 'Insufficient credits', 403: 'Scope missing or model disabled', 404: 'Model not found', 422: 'Variable-price model', 429: 'Rate limited', 502: 'Provider error', 503: 'Service not activated', 504: 'Provider timeout' } as Record<number, string>)[c], content: { 'application/json': { schema: err } } }]));

function spec(origin: string) {
  return {
    openapi: '3.1.0',
    info: { title: 'Wasl AI API', version: '1.0.0', description: 'OpenAI-compatible chat completions billed against prepaid Wasl credits, plus public catalog and pricing endpoints. Create keys in the dashboard.' },
    servers: [{ url: `${origin}/api/v1` }],
    components: {
      securitySchemes: { waslKey: { type: 'http', scheme: 'bearer', description: 'Wasl API key: wasl_ followed by 64 hex characters' } },
      schemas: {
        Error: { type: 'object', properties: { error: { type: 'object', properties: { message: { type: 'string' }, type: { type: 'string' }, code: { type: 'string' } }, required: ['message', 'code'] } } },
        Message: { type: 'object', required: ['role'], properties: { role: { enum: ['system', 'user', 'assistant', 'tool', 'developer'] }, content: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'object' } }, { type: 'null' }] } } },
        ChatRequest: {
          type: 'object', required: ['model', 'messages'],
          properties: {
            model: { type: 'string', example: 'openai/gpt-4.1' },
            messages: { type: 'array', minItems: 1, maxItems: 200, items: { $ref: '#/components/schemas/Message' } },
            stream: { type: 'boolean', description: 'Server-sent events in the OpenAI chunk format' },
            max_tokens: { type: 'integer', minimum: 1, maximum: 16384, default: 2048, description: 'Also used to reserve the maximum cost before the request is sent' },
            temperature: { type: 'number', minimum: 0, maximum: 2 }, top_p: { type: 'number', minimum: 0, maximum: 1 },
            stop: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, maxItems: 4 }] },
            seed: { type: 'integer' }, presence_penalty: { type: 'number' }, frequency_penalty: { type: 'number' },
            response_format: { type: 'object' }, tools: { type: 'array', maxItems: 64 }, tool_choice: {},
          },
        },
        ChatResponse: { type: 'object', description: 'OpenAI chat.completion object, plus a `wasl` field', properties: { id: { type: 'string' }, model: { type: 'string' }, choices: { type: 'array', items: { type: 'object' } }, usage: { type: 'object', properties: { prompt_tokens: { type: 'integer' }, completion_tokens: { type: 'integer' }, total_tokens: { type: 'integer' } } }, wasl: { type: 'object', properties: { request_id: { type: 'string' }, charged_usd: { type: 'number' } } } } },
      },
    },
    paths: {
      '/chat/completions': {
        post: {
          summary: 'Create a chat completion', security: [{ waslKey: [] }], description: 'Requires the "chat" scope. Charged at provider cost plus platform margin; failed requests are not charged.',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatRequest' } } } },
          responses: { '200': { description: 'Completion (JSON) or event stream when stream=true', headers: { 'X-Request-Id': { schema: { type: 'string' } } }, content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatResponse' } }, 'text/event-stream': { schema: { type: 'string' } } } }, ...errResponses([400, 401, 402, 403, 404, 422, 429, 502, 503, 504]) },
        },
      },
      '/balance': { get: { summary: 'Current credit balance', security: [{ waslKey: [] }], description: 'Requires the "usage" scope.', responses: { '200': { description: 'Balance', content: { 'application/json': { schema: { type: 'object', properties: { balance_usd: { type: 'number' }, currency: { const: 'USD' } } } } } }, ...errResponses([401, 403]) } } },
      '/usage': { get: { summary: 'Usage summary', security: [{ waslKey: [] }], description: 'Requires the "usage" scope.', parameters: [{ name: 'days', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 365, default: 30 } }], responses: { '200': { description: 'Totals, daily buckets, and per-model breakdown' }, ...errResponses([401, 403]) } } },
      '/models': { get: { summary: 'List catalog models', parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }, { name: 'provider', in: 'query', schema: { type: 'string' } }, { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } }], responses: { '200': { description: 'Models; prices are USD per 1M tokens' } } } },
      '/models/{id}': { get: { summary: 'Get one model', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, example: 'anthropic/claude-sonnet-5.5' }], responses: { '200': { description: 'Model' }, '404': { description: 'Not found' } } } },
      '/pricing/estimate': { get: { summary: 'Estimate cost (display only, excludes platform margin)', parameters: ['model', 'input_tokens', 'output_tokens', 'requests', 'currency'].map(name => ({ name, in: 'query', required: name === 'model', schema: { type: name === 'model' || name === 'currency' ? 'string' : 'integer' } })), responses: { '200': { description: 'Estimate' }, '400': { description: 'Invalid parameters' }, '404': { description: 'Model not found' } } } },
      '/health': { get: { summary: 'Live component checks', responses: { '200': { description: 'Healthy' }, '503': { description: 'Degraded (database unavailable)' } } } },
      '/status': { get: { summary: 'Health plus recent incidents', responses: { '200': { description: 'Status' } } } },
    },
  };
}

export function GET(request: Request) {
  return Response.json(spec(new URL(request.url).origin), { headers: { 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' } });
}
