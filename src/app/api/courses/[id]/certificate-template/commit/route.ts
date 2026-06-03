import { NextRequest } from "next/server";
import { z } from "zod";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";
import { generateSupportId } from "@/lib/support/supportId";

export const runtime = "nodejs";

const commitSchema = z.object({
  storage_path: z.string().min(1).max(600),
  file_name: z.string().min(1).max(300),
  mime: z.enum(["application/pdf", "image/png", "image/jpeg", "image/webp"]),
  size_bytes: z.number().int().positive().max(10 * 1024 * 1024),
});

function splitStoragePath(path: string): { directory: string; fileName: string } | null {
  const idx = path.lastIndexOf("/");
  if (idx <= 0 || idx >= path.length - 1) return null;
  return {
    directory: path.slice(0, idx),
    fileName: path.slice(idx + 1),
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  if (caller.role !== "organization_admin" || !caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const body = await request.json().catch(() => null);
  const parsed = commitSchema.safeParse(body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "Invalid request.", { status: 400 });

  const { storage_path, file_name, mime, size_bytes } = parsed.data;
  const expectedPrefix = `courses/${id}/template-`;
  if (!storage_path.startsWith(expectedPrefix)) {
    return apiError("VALIDATION_ERROR", "Invalid storage path.", { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  const { data: courseRow, error: courseError } = await admin
    .from("courses")
    .select("id, organization_id")
    .eq("id", id)
    .single();

  if (courseError || !courseRow?.id) return apiError("NOT_FOUND", "Course not found.", { status: 404 });
  if (courseRow.organization_id !== caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const split = splitStoragePath(storage_path);
  if (!split) return apiError("VALIDATION_ERROR", "Invalid storage path.", { status: 400 });

  let objectExists = false;
  let listErrorMessage: string | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { data: objects, error: listError } = await admin.storage
      .from("certificate-templates")
      .list(split.directory, { limit: 10, search: split.fileName });

    if (listError) {
      listErrorMessage = listError.message;
    } else {
      objectExists = Array.isArray(objects) && objects.some((object) => object.name === split.fileName);
      if (objectExists) break;
    }

    if (attempt < 3) await wait(250);
  }

  if (!objectExists) {
    const supportId = generateSupportId();
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 409,
      code: "CONFLICT",
      publicMessage: "Uploaded certificate template was not found.",
      internalMessage: listErrorMessage ?? "Storage object missing after signed upload.",
      details: { support_id: supportId, course_id: id, storage_path },
    });
    return apiError("CONFLICT", "Uploaded certificate template was not found. Please try uploading it again.", { status: 409, supportId });
  }

  const { data: existing } = await admin
    .from("course_certificate_templates")
    .select("id, storage_bucket, storage_path")
    .eq("course_id", id)
    .maybeSingle();

  const { data: upserted, error: upsertError } = await admin
    .from("course_certificate_templates")
    .upsert(
      {
        course_id: id,
        organization_id: courseRow.organization_id,
        storage_bucket: "certificate-templates",
        storage_path,
        file_name,
        mime_type: mime,
        size_bytes,
        uploaded_by: caller.id,
      },
      { onConflict: "course_id" }
    )
    .select("id, created_at, course_id, storage_bucket, storage_path, file_name, mime_type, size_bytes")
    .single();

  if (upsertError || !upserted) {
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 500,
      code: "INTERNAL",
      publicMessage: "Failed to save certificate template.",
      internalMessage: upsertError?.message,
    });
    return apiError("INTERNAL", "Failed to save certificate template.", { status: 500 });
  }

  if (existing?.storage_bucket && existing?.storage_path && existing.storage_path !== storage_path) {
    try {
      await admin.storage.from(existing.storage_bucket).remove([existing.storage_path]);
    } catch {
      // ignore
    }
  }

  try {
    await admin.from("audit_logs").insert({
      actor_user_id: caller.id,
      actor_email: caller.email,
      actor_role: caller.role,
      action: "upload_certificate_template",
      entity: "courses",
      entity_id: id,
      metadata: { path: storage_path, file_name },
    });
  } catch {
    // ignore
  }

  await logApiEvent({
    request,
    caller,
    outcome: "success",
    status: 201,
    publicMessage: "Certificate template uploaded.",
    details: { course_id: id },
  });
  return apiOk({ template: upserted }, { status: 201, message: "Certificate template uploaded." });
}
