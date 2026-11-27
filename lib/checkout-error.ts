/** Text for checkout blocked while paid inference is off. The server sends both languages; the client shows one by page language. */
export const INFERENCE_OFF_MESSAGE = {
  en: 'Adding credit is paused: the AI service is not switched on yet, so there is nothing to spend credit on.',
  ar: 'شحن الرصيد متوقف حاليًا: خدمة الذكاء الاصطناعي غير مفعّلة بعد، فلا يوجد ما يُستهلك به الرصيد.',
} as const;

export function inferenceOffMessage(lang: 'ar' | 'en'): string {
  return INFERENCE_OFF_MESSAGE[lang];
}
