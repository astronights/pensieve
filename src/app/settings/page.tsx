import { cookies } from "next/headers";
import BackLink from "@/components/BackLink";
import SettingsForm from "@/components/SettingsForm";
import ThemePicker from "@/components/ThemePicker";
import { getDb } from "@/db";
import { getSettings } from "@/lib/settings";
import { THEME_COOKIE, parseTheme } from "@/lib/theme";

export default async function SettingsPage() {
  const [settings, cookieStore] = await Promise.all([getSettings(getDb()), cookies()]);
  return (
    <main>
      <header>
        <BackLink />
      </header>
      <h1>Settings</h1>
      <ThemePicker initial={parseTheme(cookieStore.get(THEME_COOKIE)?.value)} />
      <SettingsForm initial={settings} />
    </main>
  );
}
