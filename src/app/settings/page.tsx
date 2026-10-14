import { connection } from "next/server";
import BackLink from "@/components/BackLink";
import SettingsForm from "@/components/SettingsForm";
import { getDb } from "@/db";
import { getSettings } from "@/lib/settings";

export default async function SettingsPage() {
  await connection();
  const settings = await getSettings(getDb());
  return (
    <main>
      <header>
        <BackLink />
      </header>
      <h1>Settings</h1>
      <SettingsForm initial={settings} />
    </main>
  );
}
