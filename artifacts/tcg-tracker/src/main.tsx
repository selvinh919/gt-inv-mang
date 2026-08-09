import { createRoot } from "react-dom/client";
import { setAuthTokenGetter, setBaseUrl } from "@workspace/api-client-react";
import App from "./App";
import "./index.css";
import { getStoredAuthToken } from "@/lib/auth-session";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim();
if (apiBaseUrl) {
	setBaseUrl(apiBaseUrl);
}

const root = createRoot(document.getElementById("root")!);
setAuthTokenGetter(() => getStoredAuthToken());

root.render(<App />);
