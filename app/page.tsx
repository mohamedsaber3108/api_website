import WaslApp from "./wasl-app";
import { serverLang } from "./lang-server";

export default async function Home() {
  return <WaslApp initialLang={await serverLang()} />;
}
