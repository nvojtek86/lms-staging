import { NextRequest } from "next/server";
import { z } from "zod";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";
import { generateSupportId } from "@/lib/support/supportId";

export const runtime = "nodejs";

function getExtFromMime(mime: string): string {
  if (mime === "application/pdf") return "pdf";
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  return "bin";
}

const signSchema = z.object({
  file_name: z.string().min(1).max(300),
  mime: z.enum(["application/pdf", "image/png", "image/jpeg", "image/webp"]),
  size_bytes: z.number().int().positive().max(10 * 1024 * 1024),
});

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  if (caller.role !== "organization_admin" || !caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const body = await request.json().catch(() => null);
  const parsed = signSchema.safeParse(body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "Invalid request.", { status: 400 });

  const admin = createAdminSupabaseClient();
  const { data: courseRow, error: courseError } = await admin
    .from("courses")
    .select("id, organization_id")
    .eq("id", id)
    .single();

  if (courseError || !courseRow?.id) return apiError("NOT_FOUND", "Course not found.", { status: 404 });
  if (courseRow.organization_id !== caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const bucket = "certificate-templates";
  const ext = getExtFromMime(parsed.data.mime);
  const ts = Date.now();
  const objectName = `courses/${id}/template-${ts}.${ext}`;
  const { data: signed, error: signedError } = await admin.storage.from(bucket).createSignedUploadUrl(objectName);

  if (signedError || !signed?.token) {
    const supportId = generateSupportId();
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 500,
      code: "INTERNAL",
      publicMessage: "Failed to create signed upload URL.",
      internalMessage: signedError?.message,
      details: { course_id: id, support_id: supportId },
    });
    return apiError("INTERNAL", "Failed to create signed upload URL.", { status: 500, supportId });
  }

  return apiOk(
    {
      bucket_id: bucket,
      object_name: objectName,
      token: signed.token,
    },
    { status: 200 }
  );
}
