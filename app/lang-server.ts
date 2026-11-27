import { headers } from "next/headers";
import { DEFAULT_LANG, langFromCookieHeader, type Lang } from "../lib/lang";

/** Page language for this request, from the wasl_lang cookie. Arabic when the cookie is missing or invalid. */
export async function serverLang(): Promise<Lang> {
  const h = await headers();
  return langFromCookieHeader(h.get("cookie")) ?? DEFAULT_LANG;
}
