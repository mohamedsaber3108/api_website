# PROJECT COMPLETE AUDIT — Wasl AI

**تاريخ الجرد:** 27 أكتوبر 2026  
**النطاق:** نسخة المصدر `wasl-ai-complete-source-v6.zip` فقط، دون تعديل أي ملف في المشروع.  
**منهجية الجرد:** مراجعة شجرة الملفات، الـroutes، مكونات React، APIs، migrations، ملفات التشغيل، `package.json`، وملفّات البيانات الموجودة. لا يعتمد هذا التقرير على افتراض أن ميزة موجودة لمجرد ظهورها في التصميم.

## 1. ملخص تنفيذي

المشروع هو منصة **Wasl AI** بواجهة عربية/إنجليزية لاستكشاف كتالوج نماذج AI وتسعيرها، مع نموذج أولي لحساب مطوّر ومفاتيح API، وتجربة BYOK بمفتاح OpenRouter الخاص بالمستخدم.

| المجال | الحالة الفعلية | الدليل في الكود |
|---|---|---|
| عرض النماذج والأسعار | مكتمل وظيفيًا للقراءة | `app/api/catalog/route.ts` و`components/catalog-explorer.tsx` |
| تحويل العملات USD/EGP/SAR/AED/EUR | مكتمل للعرض التقديري | `app/api/fx/route.ts` و`lib/pricing.ts` |
| البحث، الفلاتر، المقارنة، CSV، المفضلة | مكتمل في الواجهة | `components/catalog-explorer.tsx`؛ المفضلة محلية في المتصفح |
| تجربة نموذج بمفتاح المستخدم | مكتمل جزئيًا، BYOK فقط | `components/live-try.tsx` و`app/api/v1/try/route.ts` |
| حساب المطور ومفاتيح Wasl | موجود جزئيًا | `components/account-console.tsx` و`/api/account*` |
| الاستدلال عبر مفتاح Wasl | غير منفذ | `/api/v1/chat/completions` يرجع `503` دائمًا |
| رصيد، دفع، فواتير، ضرائب، استرداد | غير منفذ | لا توجد جداول أو APIs أو SDK بوابة دفع |
| تسجيل دخول/حساب مستقل | غير منفذ؛ توجد فقط هوية ChatGPT اختيارية | `app/chatgpt-auth.ts` |
| لوحة إدارة | غير منفذة | لا route أو schema أو حماية role لإدارة داخلية |
| معالجة تذاكر الدعم | التسجيل في DB موجود؛ صندوق عمل الإدارة غير موجود | `/api/support` و`supportTickets` |

**النتيجة:** المشروع ليس جاهزًا بعد لبيع API للعملاء. يصلح حاليًا كمنتج اكتشاف نماذج، حاسبة أسعار، وتجربة شخصية BYOK. لا ينبغي تفعيل بيع API أو تحصيل مدفوعات قبل إكمال مزود inference مرخّص، الفوترة، webhooks، الحماية، ولوحة التشغيل.

---

## 2. بنية المشروع الحالية

```text
app/                     صفحات Vinext/Next وAPI routes
components/              واجهات المنتج ومكتبة UI مولدة
lib/                     تطبيع الكتالوج وحساب الأسعار
api/ (داخل app/)         APIs العامة، الحساب، والدعم
db/ + drizzle/           D1 schema وmigrations
data/                    لقطة كتالوج ونسب تحويل احتياطية
worker/                  Cloudflare Worker entry point
scripts/                 build/runtime/catalog refresh helpers
.openai/hosting.json     ربط Cloudflare D1 باسم DB
```

**Stack المنفذ:** React 19 + Next/Vinext + Vite + TypeScript + Tailwind 4 + Cloudflare Workers/D1 + Drizzle ORM.

---

## 3. صفحات الـFrontend الموجودة

جميع المسارات التالية تمر عبر صفحة catch-all واحدة: `app/[...slug]/page.tsx` ثم يحدد `app/wasl-app.tsx` الصفحة من `location.pathname`. لا توجد صفحة React مستقلة لكل route.

| المسار | الصفحة/المكون | الحالة | ما يعمل الآن | الحدود الفعلية |
|---|---|---|---|---|
| `/` | Home داخل `WaslApp` | مكتملة كواجهة | Hero، نماذج مميزة، CTA، FAQ، تفضيلات اللغة/المظهر/العملة | CTA يقود إلى صفحات داخلية؛ لا onboarding تجاري |
| `/models` | `CatalogExplorer` | مكتملة للقراءة | بحث، provider/category filters، ترتيب، free/tools/saved، تفاصيل، مقارنة 2–3، CSV، 24 عنصرًا مع Load more | المفضلة في `localStorage` فقط؛ لا حفظ سحابي أو روابط مقارنة قابلة للمشاركة |
| `/providers` | `Providers` في `components/discovery.tsx` | مكتملة للعرض | تجميع النماذج حسب المزوّد والانتقال لفلتره | لا صفحة مزود مستقلة، لا معلومات اتفاقيات/availability حقيقية |
| `/rankings` | `Rankings` في `components/discovery.tsx` | مكتملة للعرض | قوائم مبنية على بيانات الكتالوج والسعر والسياق | ليست benchmark حقيقيًا ولا usage rankings |
| `/pricing` | قسم داخل `WaslApp` | مكتملة للحساب التقديري | حاسبة الطلبات/tokens وجدول أول 18 نموذجًا | لا سعر بيع Wasl، لا ضرائب/رسوم/discounts/checkout |
| `/playground` | Playground + `LiveTry` | جزئية | محادثة demo محلية وتجربة BYOK حقيقية للنص | demo لا يستدعي API؛ BYOK يقتصر على prompt نصي و512 output tokens ومفتاح OpenRouter شخصي |
| `/docs` | Docs داخل `WaslApp` | جزئية | Quickstart وروابط APIs المتاحة وعينة cURL | لا OpenAPI، لا SDKs، لا مرجع أخطاء/limits كامل، وعينة paid API تشير لخدمة غير مفعلة |
| `/dashboard` | Dashboard + `AccountConsole` | جزئية | شاشة overview، تسجيل دخول ChatGPT إن توفر، إنشاء/إلغاء مفاتيح، عرض usage DB | البطاقات العلوية placeholder؛ لا رصيد أو استخدام فعلي؛ لا حساب مستقل أو workspace |
| `/use-cases` | `UseCases` | مكتملة كصفحة تعريفية | 3 حالات استخدام وروابط مسارات | لا قوالب أو journeys قابلة للحفظ |
| `/support` | `CustomerSupport` | جزئية | نموذج يكتب ticket في D1 مع validation وhoneypot وrate limit | لا بريد/CRM/تنبيهات/SLA أو شاشة متابعة للعميل |
| `/trust` | `TrustCenter` | مكتملة كإفصاح مبدئي | يوضح المتاح وما ينتظر التفعيل والتزامات عامة | ليست صفحات قانونية مكتملة أو سياسة قابلة للاعتماد |
| `/status` | `StatusCenter` | جزئية | يقرأ `/api/v1/health` ويعرض الحالة | health ثابت ولا يتحقق من D1/provider/payment أو تاريخ incidents |

### الصفحات/المسارات المحجوزة خارج كود التطبيق

| المسار | المصدر | الحالة |
|---|---|---|
| `/signin-with-chatgpt` | منصة الاستضافة، لا route محلي | مدعوم كـ SIWC/ChatGPT sign-in عند توفر headers من الاستضافة |
| `/signout-with-chatgpt` | منصة الاستضافة، لا route محلي | مدعوم على مستوى المنصة |
| `/callback` | منصة الاستضافة، لا route محلي | callback محجوز للمصادقة |

---

## 4. الصفحات المطلوبة والناقصة

هذه ليست تخمينات واجهة؛ هي الصفحات اللازمة لاستكمال ما تعد به الواجهة الحالية: حسابات، API keys، usage، credits، checkout، دعم، وإدارة التشغيل.

| الأولوية | الصفحة المطلوبة | سبب الحاجة | الاعتماد الخلفي |
|---|---|---|---|
| P0 | Login | لا يوجد تسجيل دخول مستقل؛ dashboard لا يضمن هوية خارج ChatGPT | Auth provider، sessions، rate limits |
| P0 | Register + email verification | لا يوجد إنشاء حساب عميل مستقل أو تحقق بريد | Users table، email service، token flow |
| P0 | Forgot/reset password | غائبة كليًا إذا كان الدخول مستقلًا | Auth provider/email service |
| P0 | Customer dashboard حقيقي | dashboard الحالي مزيج preview وconsole، لا يعرض balance أو metrics حقيقية | usage aggregation، credits، invoices، RBAC |
| P0 | Billing & checkout | الواجهة تذكر الدفع والرصيد لكن لا يوجد تنفيذ | Payment gateway، orders/payments/webhooks/tax |
| P0 | Credits / transactions | لا يوجد سجل شراء أو استهلاك قابل للمحاسبة | Ledger غير قابل للتعديل، usage metering |
| P0 | Invoice / receipts | لا فواتير أو تنزيل PDFs | Invoicing service + tax configuration |
| P0 | API key management الكامل | الموجود ينشئ/يلغي فقط | last-used، scopes، expiration، key rotation، audit events |
| P0 | API usage & analytics | usageEvents schema موجود لكن لا يكتب أي inference event | event pipeline + aggregation + charts |
| P0 | Admin console | لا توجد إدارة مستخدمين أو تذاكر أو أسعار أو عمليات | roles، admin auth، audit log |
| P0 | Support ticket inbox/detail | tickets تُسجل فقط ولا توجد وسيلة قراءتها أو الرد عليها | ticket workflow، notifications، RBAC |
| P0 | Legal pages مستقلة | trust فيه ملخص، لا توجد Terms/Privacy/Refund/Acceptable Use فعلية | محتوى قانوني مع versioning/consent |
| P1 | Workspace/team settings | الواجهة تذكر فرق العمل، وليس هناك schema أو UI | organizations, memberships, invitations, roles |
| P1 | Provider/model availability page | يجب بيان النماذج التي يسمح العقد التجاري بتقديمها | provider contracts, routing/config |
| P1 | Service status history/incidents | status الحالي لحظي وثابت | monitoring, incident records |
| P1 | Account profile/security | تعديل الاسم، البريد، MFA، sessions، delete account | identity provider + account settings |
| P1 | Saved favorites/saved comparisons | المفضلة محلية فقط | user preferences tables/APIs |
| P1 | Blog/changelog/release notes | مفيد لمنتج عام، غير موجود | CMS أو MDX pipeline |
| P2 | Enterprise contact / quote workflow | نموذج support عام فقط | CRM integration + lead assignment |
| P2 | Referral/coupons/discounts | غير موجود | promotion rules + ledger |
| P2 | Localization settings/content management | واجهة عربية/إنجليزية موجودة فقط في strings برمجية | i18n content pipeline |

---

## 5. الـFeatures والمكونات الموجودة

### 5.1 وظائف منتج ظاهرة للمستخدم

| Feature | الحالة | التخزين/الخدمة |
|---|---|---|
| العربية/الإنجليزية مع RTL/LTR | يعمل | `localStorage`: `wasl-lang` |
| Dark/Light mode | يعمل | `localStorage`: `wasl-theme` |
| العملات الخمس | يعمل للعرض | API FX مع fallback snapshot؛ `wasl-currency` محلي |
| كتالوج 100+ نموذج | يعمل | OpenRouter Models API مع لقطة محلية fallback |
| بحث/فلترة/ترتيب كتالوج | يعمل | داخل المتصفح على بيانات الكتالوج المحمّلة |
| تفاصيل نموذج | يعمل | modal داخل `CatalogExplorer` |
| مقارنة نماذج | يعمل | حالة session محلية، حتى 3 نماذج |
| تصدير CSV | يعمل | Blob محلي في المتصفح |
| المفضلة | يعمل محليًا فقط | `localStorage`: `wasl-favorites` |
| مزودون وتصنيفات | يعمل | حسابات مشتقة من الكتالوج، لا بيانات خارجية |
| حاسبة تكلفة | يعمل كتقدير | أسعار OpenRouter × FX؛ لا رسوم منصة أو taxes |
| Playground demo | يعمل كواجهة فقط | رد ثابت محلي، لا API |
| Live BYOK | يعمل بشروط | يمرر مفتاح المستخدم إلى OpenRouter ولا يخزنه |
| Dashboard preview | يعمل كواجهة | لا metrics حقيقية في البطاقات العلوية |
| إنشاء/إلغاء Wasl API key | منفذ | D1 + SHA-256 hash؛ مفتاح يُعرض مرة واحدة |
| دعم/تفعيل ticket | منفذ جزئيًا | D1 + validation + 3 طلبات/بريد/ساعة |
| Trust/use cases/status | موجود | content static؛ status يقرأ health API |

### 5.2 مكونات التطبيق المخصصة

| الملف | المكونات/الدور |
|---|---|
| `app/wasl-app.tsx` | shell، التنقل، home، pricing، docs، dashboard preview، اللغة/المظهر/العملة |
| `components/catalog-explorer.tsx` | `CatalogExplorer`، `CatalogCard`، `ModelBadge`، تفاصيل/مقارنة/تصدير |
| `components/discovery.tsx` | `Providers` و`Rankings` |
| `components/live-try.tsx` | نموذج BYOK وعرض response/usage |
| `components/account-console.tsx` | حساب ChatGPT، المفاتيح، سجل الاستخدام |
| `components/customer-center.tsx` | `CustomerSupport`، `TrustCenter`، `StatusCenter`، `UseCases` |
| `components/connector-error.tsx` | معالجة أخطاء connector runtime |
| `hooks/use-mobile.ts` | hook لحجم الشاشة |

### 5.3 مكتبة UI الموجودة في المصدر

`components/ui/` تحتوي على مجموعة shadcn/Base UI كبيرة (Accordion, Dialog, Form, Table, Tabs, Toast/Sonner, وغيرها). لا يظهر من مسارات المنتج الأساسية أنها مستخدمة على نطاق واسع؛ وجودها لا يعني أن feature مقابلة لها منفذة. تبقى كقاعدة قابلة لإعادة الاستخدام بعد التحقق من الاستيراد وقت التنفيذ.

---

## 6. الـBackend APIs الحالية

| Endpoint | الحالة | المصادقة | السلوك الفعلي |
|---|---|---|---|
| `GET /api/catalog` | يعمل | عام | يقرأ OpenRouter Models API؛ cache ساعة؛ fallback `data/catalog-snapshot.json` |
| `GET /api/fx` | يعمل | عام | يقرأ ExchangeRate API؛ cache يوم؛ fallback `data/fx-snapshot.json` |
| `GET /api/v1/models` | يعمل | عام + CORS `*` | بحث `q`، provider، offset، limit 1–100 |
| `GET /api/v1/models/:id` | يعمل | عام + CORS `*` | تفاصيل نموذج من الكتالوج الحالي |
| `GET /api/v1/pricing/estimate` | يعمل | عام + CORS `*` | تقدير model/input/output/requests/currency؛ معلّم `display_only` |
| `GET /api/v1/health` | يعمل شكليًا | عام | يرجع `ok` للكتالوج و`not_configured` للاستدلال والدفع والمفاتيح |
| `POST /api/v1/try` | يعمل جزئيًا | مفتاح OpenRouter للمستخدم | proxy BYOK للنص؛ 4,000 حرف، 512 token، 45 ثانية، لا تخزين مفتاح |
| `POST /api/v1/chat/completions` | غير منفذ | لا يتحقق من key | يرجع `503 service_not_activated` دائمًا |
| `GET /api/account` | يعمل جزئيًا | ChatGPT identity | ينشئ account عند أول طلب ويعرض keys + usage؛ usage لا يُنتج حاليًا |
| `POST /api/account/keys` | يعمل جزئيًا | ChatGPT identity + same-origin | ينشئ حتى 10 مفاتيح ويحفظ SHA-256 فقط |
| `DELETE /api/account/keys` | يعمل جزئيًا | ChatGPT identity + same-origin | soft revoke لمفتاح يخص المستخدم |
| `POST /api/support` | يعمل جزئيًا | اختياري + same-origin | validation/honeypot/rate limit وinsert ticket في D1 |

### APIs يجب إنشاؤها قبل التشغيل التجاري

| المجال | أمثلة endpoints المطلوبة |
|---|---|
| Auth | `/auth/register`, `/auth/login`, `/auth/logout`, `/auth/verify-email`, `/auth/forgot-password`, `/auth/reset-password`, `/auth/sessions` |
| Profile/account | `/v1/me`, `/v1/me/preferences`, `/v1/me/security`, `/v1/me/delete` |
| Organizations | `/v1/organizations`, `/v1/organizations/:id/members`, `/invitations` |
| API keys | `/v1/keys`, `/v1/keys/:id/rotate`, `/v1/keys/:id/scopes`, `/v1/keys/:id/usage` |
| Inference | `/v1/chat/completions`, optionally `/v1/responses`, streaming/SSE، model capability validation، auth/scopes/quota/metering |
| Billing | `/v1/billing/balance`, `/checkout/session`, `/payments/webhook`, `/invoices`, `/transactions`, `/refunds` |
| Usage | `/v1/usage`, `/v1/usage/summary`, `/v1/usage/export` |
| Support | `/v1/support/tickets`, `/v1/support/tickets/:id`, admin replies/status |
| Admin | `/admin/users`, `/admin/tickets`, `/admin/models`, `/admin/pricing`, `/admin/usage`, `/admin/audit-log` |
| Operations | `/v1/status`, `/v1/incidents`, webhook endpoints للـprovider/payment/email |

---

## 7. قاعدة البيانات الحالية

**المزود المجهز:** Cloudflare D1 باسم `DB` في `.openai/hosting.json`.  
**ORM:** Drizzle؛ migrations موجودة في `drizzle/`.

| الجدول | الحقول الأساسية | الاستخدام الحالي | الفجوات |
|---|---|---|---|
| `accounts` | `user_id`, `email`, `created_at` | يُنشأ عند استدعاء account/key API بهوية ChatGPT | لا display name/update/deletion/status/role/auth provider ID مستقل |
| `api_keys` | `id`, `user_id`, `name`, `prefix`, `hash`, `created_at`, `revoked_at` | إنشاء وإلغاء مفاتيح Wasl | لا scope/expiry/last_used/IP restrictions/rotation/audit |
| `usage_events` | `user_id`, `key_id`, `model`, tokens, cost, time | يُقرأ في dashboard | لا يوجد مسار يكتب فيه events حاليًا |
| `support_tickets` | `id`, optional user, contact, subject, message, status, time | يُنشأ من support form | لا assignee/replies/priority/attachments/customer visibility |

### جداول مطلوبة للاستكمال

| المجال | جداول مقترحة |
|---|---|
| الهوية والصلاحيات | `users`, `auth_identities`, `sessions`, `password_resets`, `email_verifications`, `roles`, `user_roles` |
| الشركات | `organizations`, `organization_members`, `organization_invitations`, `projects` |
| الاستدلال | `model_configs`, `provider_routes`, `request_logs` (مع سياسة retention)، `rate_limit_buckets`, `idempotency_keys` |
| الفوترة | `credit_ledger`, `billing_accounts`, `payment_customers`, `payments`, `payment_webhook_events`, `invoices`, `invoice_lines`, `refunds`, `tax_records` |
| الأسعار | `price_books`, `model_prices`, `currency_rates`, `discounts`, `coupons` |
| الدعم | `ticket_messages`, `ticket_assignments`, `ticket_events`, `support_attachments` |
| الامتثال والتشغيل | `audit_logs`, `consents`, `legal_document_versions`, `incidents`, `status_checks` |
| تجربة المستخدم | `user_preferences`, `saved_models`, `saved_comparisons` |

**ملاحظة تصميمية:** الائتمان والمدفوعات يجب أن يعتمدا على ledger append-only ومعالجة webhooks idempotently؛ لا يكفي تحديث balance داخل جدول مستخدم عادي.

---

## 8. الخدمات الخارجية الموجودة والمطلوبة

| الخدمة | الحالة الحالية | الاستخدام | ما يلزم قبل البيع |
|---|---|---|---|
| OpenRouter Models API | مستخدمة للكتالوج | `GET /api/catalog` | تثبيت مصدر بيانات وشروط/ترخيص الاستخدام |
| OpenRouter Chat API | مستخدمة فقط لـBYOK | `POST /api/v1/try` | لا تستخدمها لإعادة بيع API دون اتفاق مناسب؛ الكود لا يفعّل ذلك حاليًا |
| ExchangeRate API | مستخدمة | FX display | مصدر موثوق/اتفاق SLA أو rate source تجاري للفوترة |
| ChatGPT SIWC | اختياري من منصة الاستضافة | هوية dashboard | auth مستقل أو سياسة واضحة أن المنتج يعتمد على ChatGPT |
| Cloudflare D1 | مهيأة | accounts/keys/tickets | production migrations/backups/monitoring/access controls |
| بوابة دفع | غير موجودة | — | مزود يدعم السوق/العملات المطلوبة، hosted checkout، webhooks، refunds |
| Email transactional | غير موجودة | — | verification، reset password، invoices، support notifications |
| مزود inference مرخّص | غير موجود | — | عقد إعادة بيع/تجميع أو model-provider agreements، secrets manager، routing |
| Monitoring/logging | غير موجود في الكود | — | error tracking، metrics، tracing، alerts، uptime checks |
| مكافحة إساءة الاستخدام | محدودة | same-origin/honeypot/simple hourly ticket limit | WAF/rate limiting، abuse controls، quotas، moderation policy |
| Object storage | R2 معلن `null` | — | فقط إذا أضيف uploads/exports/invoices/attachments |

---

## 9. الـLibraries الموجودة

### Dependencies مباشرة في `package.json`

| الحزمة/المجموعة | الغرض |
|---|---|
| `react`, `react-dom`, `next`, `vinext`, `vite` | runtime والواجهة/build |
| `typescript`, `@types/*`, `eslint`, `eslint-config-next` | typing/lint |
| `tailwindcss`, `@tailwindcss/postcss`, `tw-animate-css`, `tailwind-merge`, `clsx`, `class-variance-authority` | التصميم والـCSS variants |
| `lucide-react` | الأيقونات المستخدمة في واجهة المنتج |
| `drizzle-orm`, `drizzle-kit` | D1 schema/migrations |
| `@cloudflare/vite-plugin`, `@cloudflare/workers-types`, `wrangler` | Cloudflare runtime وD1 |
| `@base-ui/react`, `@shadcn/react`, `radix-ui` | أساس مكتبة UI الموجودة تحت `components/ui` |
| `react-hook-form`, `@hookform/resolvers`, `zod` | أدوات forms/validation؛ ليست واضحة الاستخدام في صفحات المنتج المخصصة الحالية |
| `recharts` | charts؛ لا يظهر chart product فعلي في الصفحات الرئيسية الحالية |
| `date-fns`, `embla-carousel-react`, `cmdk`, `vaul`, `sonner`, `input-otp`, `react-day-picker`, `react-resizable-panels` | أدوات/مكونات UI متاحة في المشروع؛ يلزم تحقق استيراد feature-by-feature قبل الاعتماد عليها |
| `json-rpc-2.0`, `raw-body` | أدوات runtime/connector؛ ليست جزءًا من مسار منتج Wasl المباشر |

### Libraries أو SDKs لازمة ولم تُضف بعد

| الاحتياج | نوع المكتبة/SDK المطلوب |
|---|---|
| Auth مستقل | Auth provider SDK أو implementation آمن لـsessions/password hashing/MFA |
| Payment | SDK بوابة الدفع المختارة + signature validation للـwebhooks |
| Email | transactional email SDK/provider |
| Rate limits | Cloudflare-native rate limiting/KV/DO أو خدمة موثوقة |
| Monitoring | error tracking + metrics/tracing SDK |
| Validation/API docs | OpenAPI tooling + request schema validation في كل endpoint |
| Security | secrets manager، CSRF strategy، bot/abuse controls، audit logger |
| Charts usage | يمكن استخدام `recharts` الموجود بعد إتاحة usage aggregates |

---

## 10. الـRepositories وملكية المصدر

| العنصر | ما ثبت من الملفات | الحالة |
|---|---|---|
| مستودع Wasl AI على GitHub | لا يوجد `.git` أو `origin` داخل archive | لا يمكن معرفة أو توثيق رابط repo من المصدر المقدم |
| مستودع Vinext | README يشير إلى `https://github.com/cloudflare/vinext` | مرجع framework، وليس بالضرورة dependency الوحيد المباشر |
| OpenRouter | تستخدم APIs عامة في الكود | ليس repository مستخدمًا ككود محلي |
| ExchangeRate API | تستخدم endpoint عام | ليس repository مستخدمًا ككود محلي |
| shadcn/Base UI/Radix | مثبتة كحزم npm/مكونات مولدة | يلزم ربطها بسجلات npm/المستندات الرسمية عند مراجعة التراخيص |

**إجراء عند رفع المشروع إلى GitHub:** أنشئ مستودعًا جديدًا لـWasl AI من محتويات source zip، ثم أضف `LICENSE` و`SECURITY.md` و`CONTRIBUTING.md` و`.env.example` وCI قبل إدخال أي secrets. هذه الملفات غير موجودة حاليًا في archive.

---

## 11. عناصر ناقصة في الأمان والتشغيل

| المجال | الموجود | المطلوب |
|---|---|---|
| API key security | SHA-256، عرض السر مرة واحدة، revoke | key scopes/expiry/rotation/last-used/rate limits/audit/secret encryption policy |
| Request validation | checks يدوية محدودة | schemas موحدة، content-type handling، payload limits لكل route، API version policy |
| CORS | public read-only APIs تسمح `*` | policy موثقة، لا تفتح authenticated APIs، preflight حيث يلزم |
| CSRF | same-origin لبعض POSTs | CSRF/session strategy موحدة عند إضافة auth مستقل |
| BYOK | المفتاح لا يُخزن من التطبيق | لا log للـAuthorization، redaction في monitoring، DPA/privacy disclosure |
| Abuse | ticket rate limit فقط | per-key/per-IP/per-account quotas، WAF، velocity checks، moderation/escalation |
| Backups | غير موثقة | D1 backups/export/restore drills |
| Secrets | لا توجد secrets production في archive | managed secrets فقط، rotation/runbook |
| Observability | health ثابت | logs, metrics, tracing, alerts, incident process |
| Legal | نصوص trust مختصرة | Terms, Privacy, DPA, refund, tax, acceptable use، consent tracking |

---

## 12. خطة استكمال بدون تكرار Features

### المرحلة 0 — تثبيت أساس العمل

1. إنشاء GitHub repo من source الحالي مع branch protection وCI: typecheck/lint/build/migration validation.
2. كتابة `.env.example` دون أسرار، ووثيقة architecture وقرار auth/payment/provider.
3. ترحيل D1 production migrations والتحقق من backups ومراقبة الأخطاء.
4. الاحتفاظ بالكتالوج، العملة، والواجهة الحالية دون إعادة بناء؛ فصلها فقط إلى routes/components عند الحاجة للصيانة.

### المرحلة 1 — الهوية والحسابات

1. اختيار Auth provider أو تنفيذ auth آمن مستقل.
2. تنفيذ Login/Register/verification/reset/session/profile.
3. إضافة roles: customer, support, admin، ثم middleware لحماية المسارات.
4. ترحيل الحسابات الحالية المبنية على ChatGPT identity بقرار واضح: ربط اختياري أو اعتماد كامل على auth الجديد.

### المرحلة 2 — بيانات الحساب وواجهة العميل

1. تحويل dashboard الحالي من preview إلى data-driven dashboard.
2. إكمال API keys: scopes, rotation, expiration, last-used, filters، وسياسة عرض secrets.
3. إضافة saved models/comparisons في DB مع الاحتفاظ بعمل localStorage كـfallback/migration.
4. تنفيذ usage summaries/exports بعد توفر usage events الحقيقية.

### المرحلة 3 — مزود inference والفوترة

1. إبرام اتفاق يسمح بتقديم inference للعملاء قبل كتابة proxy البيع.
2. بناء gateway يثبت Wasl key، scope، quota، model availability، routing، timeout/streaming، ويكتب event واحدًا idempotentًا لكل request.
3. إنشاء price book وledger للرصيد بمنطق server-side فقط.
4. ربط payment provider: checkout، webhook signature، payment states، refund، invoice/receipt/tax.
5. لا تفعّل `/api/v1/chat/completions` قبل اجتياز اختبارات auth/quota/metering/payment failure/webhook replay.

### المرحلة 4 — الدعم والإدارة والامتثال

1. إنشاء Admin Console محمية: customers، keys، usage، ledger، payments، tickets، model status، audit log.
2. إضافة ticket conversation/notifications/SLA وcustomer ticket view.
3. نشر صفحات قانونية versioned وربط consent عند register/checkout.
4. إضافة status history/incidents وmonitoring/alerts/runbooks.

### المرحلة 5 — API developer experience

1. OpenAPI spec من APIs الفعلية فقط.
2. توثيق auth/errors/rate limits/pricing/streaming/webhooks بدلاً من أمثلة خدمة غير مفعلة.
3. SDKs أو samples مصدّرة من OpenAPI، ثم Postman/Bruno collection.
4. E2E tests لرحلة register → payment → credit → key → inference → usage → invoice.

---

## 13. قائمة تسليم للتحقق قبل إطلاق بيع API

- [ ] عقد/ترخيص واضح من مزود inference يسمح بنموذج العمل.
- [ ] Auth مستقل أو قرار منتج رسمي بالاعتماد على ChatGPT SIWC.
- [ ] بوابة دفع وشروط عملات/ضرائب/استرداد متفق عليها.
- [ ] Ledger + webhooks idempotent + invoice flow.
- [ ] API gateway يتحقق من key/scopes/quota ويرصد usage بطريقة آمنة.
- [ ] Admin/support workflow فعلي.
- [ ] سياسات قانونية منشورة وموافقة المستخدم مسجلة.
- [ ] Monitoring، backups، WAF/rate limits، runbooks، واختبارات failure scenarios.
- [ ] توثيق OpenAPI/SDKs متطابق مع السلوك المنشور.
- [ ] مراجعة أمنية قبل إتاحة مفاتيح مدفوعة أو بطاقات دفع.

---

## 14. ملفات مرجعية رئيسية

| المجال | الملفات |
|---|---|
| Frontend shell/routes | `app/wasl-app.tsx`, `app/page.tsx`, `app/[...slug]/page.tsx`, `app/globals.css` |
| Catalog/pricing | `components/catalog-explorer.tsx`, `components/discovery.tsx`, `lib/catalog.ts`, `lib/pricing.ts`, `data/catalog-snapshot.json`, `data/fx-snapshot.json` |
| Playground/BYOK | `components/live-try.tsx`, `app/api/v1/try/route.ts` |
| Account/keys | `components/account-console.tsx`, `app/api/account/route.ts`, `app/api/account/keys/route.ts`, `app/chatgpt-auth.ts` |
| Support/trust/status | `components/customer-center.tsx`, `app/api/support/route.ts`, `app/api/v1/health/route.ts` |
| Public APIs | `app/api/catalog/route.ts`, `app/api/fx/route.ts`, `app/api/v1/models/**`, `app/api/v1/pricing/estimate/route.ts`, `app/api/v1/chat/completions/route.ts` |
| Database | `db/index.ts`, `db/schema.ts`, `drizzle/0000_ancient_tinkerer.sql`, `drizzle/0001_tough_legion.sql` |
| Runtime/deploy | `package.json`, `vite.config.ts`, `next.config.ts`, `worker/index.ts`, `.openai/hosting.json` |

---

## 15. حدود هذا التقرير

- لم تُنسب أي صفحة أو feature غير موجودة في source archive إلى المشروع.
- ملف الـBlueprint المرفق سابقًا عام؛ لا يضيف متطلبات Wasl محددة يمكن اعتبارها منفذة أو ناقصة دون تحويلها إلى scope معتمد.
- archive لا يحتوي remote Git history، production environment variables، dashboard بوابة دفع، أو إعدادات provider contracts؛ لذلك لا يمكن تأكيد إعدادات تشغيلية خارج الكود.
- التقرير لا يعدّل source ولا يستبدل أي تصميم أو component قائم.
