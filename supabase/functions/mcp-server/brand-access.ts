export async function verifyBrandKitAccess(
  brandKitId: string,
  userId: string,
  supabaseAdmin: any,
): Promise<boolean> {
  const { data: owned } = await supabaseAdmin
    .from("brand_kits")
    .select("id")
    .eq("id", brandKitId)
    .eq("user_id", userId)
    .maybeSingle();
  if (owned) return true;

  const { data: member } = await supabaseAdmin
    .from("brand_kit_members")
    .select("id")
    .eq("brand_kit_id", brandKitId)
    .eq("user_id", userId)
    .maybeSingle();
  return !!member;
}
