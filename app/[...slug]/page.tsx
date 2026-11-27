import WaslApp from "../wasl-app";
import { serverLang } from "../lang-server";

export default async function ProductRoute() {
  return <WaslApp initialLang={await serverLang()} />;
}
