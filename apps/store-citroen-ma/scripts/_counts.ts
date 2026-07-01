import path from "node:path"; import { config as loadEnv } from "dotenv";
loadEnv({ path: path.resolve(__dirname, "..", ".env.local") });
import { createClient } from "@supabase/supabase-js";
const supa = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
(async () => {
  const { data: b } = await supa.from("brands").select("id").eq("slug","jeep-ma").single();
  const bid=(b as any).id;
  for (const t of ["leads","service_appointments","complaints"]) {
    const { count } = await supa.from(t).select("*",{count:"exact",head:true}).eq("brand_id",bid);
    console.log(`${t}: ${count}`);
  }
})();
