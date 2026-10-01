/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  EVALUAFINANZAS — Cloud Functions v2                         ║
 * ║  Proyecto: evaluafinanzas                                    ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║  1 │ calendlyWebhook       HTTP: recibe invitee.created      ║
 * ║                            → crea diagnostico_sessions doc   ║
 * ║                            → email de pago al cliente        ║
 * ║                            → notificación interna a Jessica  ║
 * ║  2 │ checkExpiredPayments  Cron cada 15 min                  ║
 * ║                            → marca expired las sesiones      ║
 * ║                              sin pago > 3h                   ║
 * ║                            → email de cortesía al cliente    ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 *  Deploy:
 *    firebase functions:secrets:set GMAIL_PASSWORD   (una vez)
 *    firebase deploy --only functions
 */

const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { logger } = require("firebase-functions");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const {
  renderEmailInstruccionesPago,
  renderEmailInstruccionesPagoText,
  renderEmailExpiracion,
  renderEmailConfirmacion,
  renderEmailConfirmacionText,
  renderEmailNotifSesionConfirmada,
  renderEmailRecordatorio12h,
  renderEmailRecordatorio12hText,
  renderEmailReagendamiento,
  renderEmailReagendamientoText,
} = require("./emailTemplates");

admin.initializeApp();
const db = admin.firestore();

// ─────────────────────────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────────────────────────
const CONFIG = {
  gmail: {
    user: "natalia.jaramillo@abbapatrimonial.com",
    // password se inyecta al ejecutar por el secret GMAIL_PASSWORD
  },
  natalia: {
    email: "natalia.jaramillo@abbapatrimonial.com",
    nombre: "Natalia Jaramillo",
  },
  jessica: {
    email: "jesica.jaramillo@abbapatrimonial.com",
  },
  pagoDiagnosticoUrl: "https://evaluafinanzas.web.app/pago-diagnostico",
  // ⬇️  Reemplazá con el link exacto del event type "Diagnóstico patrimonial con Natalia"
  calendlyEventUrl:
    "https://calendly.com/abba-asesoria/diagnostico-patrimonial-con-natalia",
  // URL de la app de ABBA (donde el cliente completa su diagnóstico).
  //
  // ⚠️ IMPORTANTE — actualizar esta URL en cada fase del proyecto:
  //   1) Fase actual (dev/testing): apunta al preview de la rama con Model B
  //   2) Cuando el custom domain esté activo: apuntar a "https://app.abbapatrimonial.com"
  //   3) NUNCA apuntar a la URL default de Netlify (abba-finanzas.netlify.app) en producción
  //      hasta que Model B esté mergeado a main.
  appUrl: "https://feat-reestructura-diagnostico--abba-finanzas.netlify.app",
};

// ─────────────────────────────────────────────────────────────────
//  UTIL
// ─────────────────────────────────────────────────────────────────
function makeTransporter() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: CONFIG.gmail.user,
      pass: process.env.GMAIL_PASSWORD,
    },
  });
}

function formatBogota(date) {
  return date
    .toLocaleString("es-CO", {
      timeZone: "America/Bogota",
      dateStyle: "full",
      timeStyle: "short",
    })
    // 9:00 a. m. → 9:00 AM   /   3:30 p. m. → 3:30 PM
    .replace(/\s+a\.\s*m\./gi, " AM")
    .replace(/\s+p\.\s*m\./gi, " PM");
}

// ─────────────────────────────────────────────────────────────────
//  CORE — Procesa el evento de Calendly
// ─────────────────────────────────────────────────────────────────
async function handleDiagnosticoNatalia(req, res) {
  try {
    const event = req.body && req.body.event;
    if (event !== "invitee.created") {
      logger.info(`Evento ignorado: ${event}`);
      return res.status(200).send("OK - ignored");
    }

    const payload = req.body.payload;
    if (!payload) {
      logger.error("Payload vacío", { body: req.body });
      return res.status(400).send("No payload");
    }

    // ═══ ROUTING: ¿es un reagendamiento o una reserva nueva? ═══
    if (payload.rescheduled === true && payload.old_invitee) {
      return await handleRescheduledInvitee(payload, res);
    }
    return await handleNewInvitee(payload, res);
  } catch (error) {
    logger.error("💥 Error en handleDiagnosticoNatalia:", error);
    return res.status(500).send("Error");
  }
}

async function handleNewInvitee(payload, res) {
  try {
    // ═══ EXTRACCIÓN DEL PAYLOAD DE CALENDLY ═══
    const clientEmail = payload.email || "";
    const clientName =
      payload.name ||
      [payload.first_name, payload.last_name].filter(Boolean).join(" ") ||
      "Cliente";

    // Preguntas personalizadas del formulario:
    //   - Si matchea "whatsapp/celular/teléfono/móvil" → clientWhatsapp
    //   - Cualquier otra pregunta con respuesta no vacía → clientMotivo
    const qaList = payload.questions_and_answers || [];
    let clientMotivo = "";
    let clientWhatsapp = "";
    for (const qa of qaList) {
      const q = (qa.question || "").toLowerCase();
      const a = (qa.answer || "").trim();
      if (!a) continue;
      const esWhatsapp =
        q.includes("whatsapp") ||
        q.includes("celular") ||
        q.includes("teléfono") ||
        q.includes("telefono") ||
        q.includes("móvil") ||
        q.includes("movil");
      if (esWhatsapp) {
        clientWhatsapp = a;
      } else {
        clientMotivo = clientMotivo ? `${clientMotivo}\n\n${a}` : a;
      }
    }

    // Evento agendado
    const scheduledEvent = payload.scheduled_event || {};
    const sessionStart = scheduledEvent.start_time
      ? new Date(scheduledEvent.start_time)
      : new Date(Date.now() + 24 * 60 * 60 * 1000);
    // URI del evento en Calendly (para cancelar si expira sin pago)
    const calendlyEventUri = scheduledEvent.uri || "";
    // Link de Google Meet (Calendly lo genera automáticamente)
    const location = scheduledEvent.location || {};
    const meetLink = location.join_url || "";
    const eventName = scheduledEvent.name || "Diagnóstico patrimonial";

    // URLs de reagendamiento y cancelación (Calendly las provee)
    const rescheduleUrl = payload.reschedule_url || "";
    const cancelUrl = payload.cancel_url || "";

    // UUID del invitee (última parte del URI)
    const inviteeUri = payload.uri || "";
    const inviteeUuid =
      inviteeUri.split("/").pop() || `unknown-${Date.now()}`;

    logger.info("📥 Datos extraídos del webhook", {
      clientEmail,
      clientName,
      clientMotivo,
      clientWhatsapp,
      sessionStart: sessionStart.toISOString(),
      inviteeUuid,
      hasRescheduleUrl: !!rescheduleUrl,
    });

    if (!clientEmail) {
      logger.error("client_email vacío en payload de Calendly", { payload });
      return res.status(400).send("Missing client email");
    }

    // ═══ FIRESTORE ═══
    const now = new Date();
    const paymentDeadline = new Date(now.getTime() + 3 * 60 * 60 * 1000); // +3h

    const sessionDoc = {
      calendly_invitee_uuid: inviteeUuid,
      calendly_event_uri: calendlyEventUri,
      calendly_reschedule_url: rescheduleUrl,
      calendly_cancel_url: cancelUrl,
      client_email: clientEmail,
      client_name: clientName,
      client_motivo: clientMotivo,
      client_whatsapp: clientWhatsapp,
      session_start: sessionStart,
      created_at: now,
      payment_deadline: paymentDeadline,
      meet_link: meetLink,
      event_name: eventName,
      status: "pending_payment",
    };

    await db
      .collection("diagnostico_sessions")
      .doc(inviteeUuid)
      .set(sessionDoc);
    logger.info(`✅ Documento creado: ${inviteeUuid}`);

    // ═══ EMAILS ═══
    const transporter = makeTransporter();

    // 1) Al cliente — instrucciones de pago
    try {
      await sendClientPaymentInstructions(transporter, sessionDoc);
    } catch (err) {
      logger.error("❌ Error enviando email al cliente:", err);
    }

    // 2) Interno — notificación a Jessica
    try {
      await sendInternalNotification(transporter, sessionDoc);
    } catch (err) {
      logger.error("❌ Error enviando notificación interna:", err);
    }

    return res.status(200).send("OK");
  } catch (error) {
    logger.error("💥 Error en handleNewInvitee:", error);
    return res.status(500).send("Error");
  }
}

// ─────────────────────────────────────────────────────────────────
//  handleRescheduledInvitee — El cliente reagendó vía Calendly.
//  Actualiza el doc VIEJO con la nueva fecha/Meet, preservando
//  la vinculación con la cuenta app (linked_user_uid queda igual).
// ─────────────────────────────────────────────────────────────────
async function handleRescheduledInvitee(payload, res) {
  try {
    // 1) Extraer UUID del invitee VIEJO (identificador de nuestro doc)
    const oldInviteeUri = payload.old_invitee || "";
    const oldInviteeUuid = oldInviteeUri.split("/").pop() || "";
    if (!oldInviteeUuid) {
      logger.error("Reschedule sin old_invitee URI válida", { payload });
      // Fallback: tratar como reserva nueva
      return await handleNewInvitee(payload, res);
    }

    // 2) Buscar el doc viejo
    const oldSessionRef = db.collection("diagnostico_sessions").doc(oldInviteeUuid);
    const oldSessionSnap = await oldSessionRef.get();

    if (!oldSessionSnap.exists) {
      logger.warn(
        `Reschedule: doc viejo no encontrado (${oldInviteeUuid}). Tratando como reserva nueva.`
      );
      return await handleNewInvitee(payload, res);
    }

    const oldSession = oldSessionSnap.data();

    // 3) Extraer datos del NUEVO evento
    const scheduledEvent = payload.scheduled_event || {};
    const newSessionStart = scheduledEvent.start_time
      ? new Date(scheduledEvent.start_time)
      : null;
    const newCalendlyEventUri = scheduledEvent.uri || "";
    const location = scheduledEvent.location || {};
    const newMeetLink = location.join_url || "";
    const newRescheduleUrl = payload.reschedule_url || "";
    const newCancelUrl = payload.cancel_url || "";
    const newInviteeUri = payload.uri || "";
    const newInviteeUuid = newInviteeUri.split("/").pop() || "";

    if (!newSessionStart) {
      logger.error("Reschedule sin nueva fecha", { payload });
      return res.status(400).send("Missing new session_start");
    }

    // 4) Actualizar el doc viejo con la nueva info
    //    Mantenemos el mismo doc ID → el token del deep link sigue funcionando,
    //    la vinculación con clientes/{uid} se preserva, la cuenta app queda ligada.
    const oldSessionStart = oldSession.session_start && oldSession.session_start.toDate
      ? oldSession.session_start.toDate()
      : oldSession.session_start;

    await oldSessionRef.update({
      session_start: newSessionStart,
      meet_link: newMeetLink,
      calendly_event_uri: newCalendlyEventUri,
      calendly_reschedule_url: newRescheduleUrl,
      calendly_cancel_url: newCancelUrl,
      calendly_new_invitee_uuid: newInviteeUuid, // referencia al nuevo invitee de Calendly
      original_session_start: oldSessionStart,
      rescheduled_at: new Date(),
      rescheduled_by: "client_via_calendly",
      reschedule_reason: "Cliente reagendó vía Calendly",
      reminder_12h_sent_at: null,
    });

    logger.info(
      `🔄 Sesión reagendada vía Calendly: ${oldInviteeUuid} → nueva fecha ${newSessionStart.toISOString()}`
    );

    // El trigger onSessionConfirmed detecta rescheduled_at change y envía los emails.
    return res.status(200).send("OK - rescheduled");
  } catch (error) {
    logger.error("💥 Error en handleRescheduledInvitee:", error);
    return res.status(500).send("Error");
  }
}

// ─────────────────────────────────────────────────────────────────
//  EMAILS
// ─────────────────────────────────────────────────────────────────
async function sendClientPaymentInstructions(transporter, session) {
  // Traer datos de pago desde config/payment_info
  const snap = await db.collection("config").doc("payment_info").get();
  const paymentInfo = snap.exists ? snap.data() : {};

  const ctx = {
    clientName: session.client_name,
    sessionStart: session.session_start,
    paymentDeadline: session.payment_deadline,
    paymentInfo,
  };

  const html = renderEmailInstruccionesPago(ctx);
  const text = renderEmailInstruccionesPagoText(ctx);

  await transporter.sendMail({
    from: `"Natalia Jaramillo — ABBA Patrimonial" <${CONFIG.gmail.user}>`,
    to: session.client_email,
    subject: "Confirma tu diagnóstico patrimonial: datos para el pago",
    html,
    text,
  });
  logger.info(`✉️  Email de pago enviado a: ${session.client_email}`);
}

async function sendInternalNotification(transporter, session) {
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;">
      <h3 style="color:#1e2853;margin:0 0 16px;">Nueva sesión de diagnóstico reservada</h3>
      <table style="font-size:14px;color:#333;border-collapse:collapse;width:100%;">
        <tr><td style="padding:8px 12px;background:#f6f3ec;font-weight:600;width:180px;">Cliente</td>
            <td style="padding:8px 12px;border-bottom:1px solid #eee;">${session.client_name}</td></tr>
        <tr><td style="padding:8px 12px;background:#f6f3ec;font-weight:600;">Email</td>
            <td style="padding:8px 12px;border-bottom:1px solid #eee;">
              <a href="mailto:${session.client_email}">${session.client_email}</a></td></tr>
        <tr><td style="padding:8px 12px;background:#f6f3ec;font-weight:600;">WhatsApp</td>
            <td style="padding:8px 12px;border-bottom:1px solid #eee;">${session.client_whatsapp || "(no dejó)"}</td></tr>
        <tr><td style="padding:8px 12px;background:#f6f3ec;font-weight:600;">Motivo</td>
            <td style="padding:8px 12px;border-bottom:1px solid #eee;">${session.client_motivo || "(no dejó)"}</td></tr>
        <tr><td style="padding:8px 12px;background:#f6f3ec;font-weight:600;">Fecha de sesión</td>
            <td style="padding:8px 12px;border-bottom:1px solid #eee;">${formatBogota(session.session_start)}</td></tr>
        <tr><td style="padding:8px 12px;background:#f6f3ec;font-weight:600;">Deadline de pago</td>
            <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#c0392b;font-weight:600;">${formatBogota(session.payment_deadline)}</td></tr>
        <tr><td style="padding:8px 12px;background:#f6f3ec;font-weight:600;">ID interno</td>
            <td style="padding:8px 12px;border-bottom:1px solid #eee;font-family:monospace;font-size:12px;">${session.calendly_invitee_uuid}</td></tr>
      </table>
      <p style="font-size:14px;color:#333;margin-top:20px;line-height:1.5;">
        Cuando el cliente envíe el comprobante por WhatsApp, confirmá el pago en el panel de admin
        para que se libere automáticamente el enlace de Google Meet.
      </p>
    </div>`;

  await transporter.sendMail({
    from: `"Sistema ABBA" <${CONFIG.gmail.user}>`,
    to: CONFIG.jessica.email,
    subject: `Nueva reserva de diagnóstico: ${session.client_name}`,
    html,
    text: `Nueva sesión de ${session.client_name} (${session.client_email}) — sesión ${formatBogota(session.session_start)} — deadline pago ${formatBogota(session.payment_deadline)}`,
  });
  logger.info(`✉️  Notificación interna enviada a: ${CONFIG.jessica.email}`);
}

async function sendPaymentExpiredEmail(transporter, session) {
  const ctx = {
    clientName: session.client_name,
    calendlyUrl: CONFIG.calendlyEventUrl,
  };
  const html = renderEmailExpiracion(ctx);
  const text = `Hola ${session.client_name}, no recibimos tu comprobante en 3h y liberamos el horario. Cuando quieras volver a agendar: ${CONFIG.calendlyEventUrl}`;

  await transporter.sendMail({
    from: `"Natalia Jaramillo — ABBA Patrimonial" <${CONFIG.gmail.user}>`,
    to: session.client_email,
    subject: "Tu reserva expiró: puedes volver a agendar cuando quieras",
    html,
    text,
  });
}

// ─────────────────────────────────────────────────────────────────
//  CALENDLY — Cancelar evento
// ─────────────────────────────────────────────────────────────────
async function cancelCalendlyEvent(eventUri, reason) {
  if (!eventUri) return { skipped: true, reason: "no eventUri" };
  const token = process.env.CALENDLY_TOKEN;
  if (!token) {
    logger.warn("CALENDLY_TOKEN no configurado, no se cancela el evento");
    return { skipped: true, reason: "no token" };
  }

  const eventUuid = eventUri.split("/").pop();
  const url = `https://api.calendly.com/scheduled_events/${eventUuid}/cancellation`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ reason }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Calendly cancel failed: HTTP ${response.status} - ${body}`
    );
  }
  return response.json();
}

// ─────────────────────────────────────────────────────────────────
//  EXPORTS — Cloud Functions v2
// ─────────────────────────────────────────────────────────────────
exports.calendlyWebhook = onRequest(
  {
    region: "us-central1",
    secrets: ["GMAIL_PASSWORD"],
    memory: "256MiB",
    timeoutSeconds: 60,
  },
  handleDiagnosticoNatalia
);

exports.checkExpiredPayments = onSchedule(
  {
    region: "us-central1",
    schedule: "every 15 minutes",
    timeZone: "America/Bogota",
    secrets: ["GMAIL_PASSWORD", "CALENDLY_TOKEN"],
    memory: "256MiB",
    timeoutSeconds: 120,
  },
  async () => {
    const now = new Date();
    const snapshot = await db
      .collection("diagnostico_sessions")
      .where("status", "==", "pending_payment")
      .where("payment_deadline", "<=", now)
      .get();

    if (snapshot.empty) {
      logger.info("⏱  No hay sesiones expiradas.");
      return;
    }

    const batch = db.batch();
    const toProcess = [];

    snapshot.forEach((doc) => {
      const data = doc.data();
      batch.update(doc.ref, { status: "expired", expired_at: now });
      toProcess.push({
        id: doc.id,
        client_name: data.client_name,
        client_email: data.client_email,
        calendly_event_uri: data.calendly_event_uri || "",
      });
      logger.info(`Sesión expirada: ${doc.id}`);
    });

    await batch.commit();

    const transporter = makeTransporter();
    for (const s of toProcess) {
      // 1) Cancelar en Calendly (esto también libera Google Calendar)
      if (s.calendly_event_uri) {
        try {
          await cancelCalendlyEvent(
            s.calendly_event_uri,
            "Pago no recibido dentro del plazo de 3 horas."
          );
          logger.info(`✖  Calendly cancelado: ${s.id}`);
        } catch (err) {
          logger.error(`Error cancelando Calendly (${s.id}):`, err);
        }
      }
      // 2) Email al cliente
      if (s.client_email) {
        try {
          await sendPaymentExpiredEmail(transporter, s);
        } catch (err) {
          logger.error(`Error email expirado (${s.id}):`, err);
        }
      }
    }

    logger.info(`⏱  ${snapshot.size} sesiones expiradas procesadas.`);
  }
);

// ─────────────────────────────────────────────────────────────────
//  onSessionConfirmed — Se dispara cuando un asesor cambia el
//  status de una sesión a "confirmed" desde el panel de admin.
//  Envía el email al cliente con el enlace de Meet y avisa a Natalia.
// ─────────────────────────────────────────────────────────────────
exports.onSessionConfirmed = onDocumentUpdated(
  {
    document: "diagnostico_sessions/{sessionId}",
    region: "us-central1",
    secrets: ["GMAIL_PASSWORD"],
    memory: "256MiB",
    timeoutSeconds: 60,
  },
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();
    const sessionId = event.params.sessionId;

    // ═══ Caso 1: transición pending → confirmed ═══
    const justConfirmed =
      before.status !== "confirmed" && after.status === "confirmed";

    // ═══ Caso 2: reagendamiento (status queda confirmed pero session_start cambió) ═══
    const beforeRescheduledAt = before.rescheduled_at
      ? before.rescheduled_at.toDate
        ? before.rescheduled_at.toDate().getTime()
        : new Date(before.rescheduled_at).getTime()
      : 0;
    const afterRescheduledAt = after.rescheduled_at
      ? after.rescheduled_at.toDate
        ? after.rescheduled_at.toDate().getTime()
        : new Date(after.rescheduled_at).getTime()
      : 0;
    const wasRescheduled =
      before.status === "confirmed" &&
      after.status === "confirmed" &&
      afterRescheduledAt > 0 &&
      afterRescheduledAt !== beforeRescheduledAt;

    if (!justConfirmed && !wasRescheduled) return;

    const transporter = makeTransporter();

    if (justConfirmed) {
      logger.info(`🟢 Sesión confirmada: ${sessionId}`, {
        client_name: after.client_name,
        client_email: after.client_email,
        confirmed_by: after.confirmed_by,
      });

      const session = {
        ...after,
        session_start:
          after.session_start && after.session_start.toDate
            ? after.session_start.toDate()
            : after.session_start,
        confirmed_at:
          after.confirmed_at && after.confirmed_at.toDate
            ? after.confirmed_at.toDate()
            : after.confirmed_at || new Date(),
      };

      try {
        await sendConfirmationEmailToClient(transporter, session);
      } catch (err) {
        logger.error("Error email confirmación al cliente:", err);
      }

      try {
        await sendConfirmationEmailToNatalia(transporter, session);
      } catch (err) {
        logger.error("Error aviso a Natalia:", err);
      }
      return;
    }

    // wasRescheduled === true
    logger.info(`🔄 Sesión reagendada: ${sessionId}`, {
      client_name: after.client_name,
      client_email: after.client_email,
      rescheduled_by: after.rescheduled_by,
    });

    // Nota: NO cancelamos el evento viejo en Calendly.
    // Calendly ya lo canceló automáticamente cuando el cliente usó su link
    // de reagendamiento (flujo Calendly-driven). El calendly_event_uri
    // que tenemos ahora es del evento NUEVO.

    // Email al cliente con nueva fecha y nuevo Meet link
    const rescheduledSession = {
      ...after,
      session_start:
        after.session_start && after.session_start.toDate
          ? after.session_start.toDate()
          : after.session_start,
      original_session_start:
        after.original_session_start && after.original_session_start.toDate
          ? after.original_session_start.toDate()
          : after.original_session_start,
    };

    try {
      await sendReagendamientoEmailToClient(
        transporter,
        rescheduledSession,
        sessionId
      );
    } catch (err) {
      logger.error("Error email reagendamiento al cliente:", err);
    }

    // 3) Aviso a Natalia con datos actualizados
    try {
      await sendReagendamientoEmailToNatalia(transporter, rescheduledSession);
    } catch (err) {
      logger.error("Error aviso reagendamiento a Natalia:", err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────
//  EMAILS de confirmación
// ─────────────────────────────────────────────────────────────────
async function sendConfirmationEmailToClient(transporter, session) {
  const sessionToken = session.calendly_invitee_uuid || "";
  const appUrlWithToken = sessionToken
    ? `${CONFIG.appUrl}/?diag_session=${encodeURIComponent(sessionToken)}`
    : CONFIG.appUrl;

  const ctx = {
    clientName: session.client_name,
    sessionStart: session.session_start,
    meetLink: session.meet_link || "",
    eventName: session.event_name || "Diagnóstico patrimonial",
    supportEmail: CONFIG.gmail.user,
    appUrl: appUrlWithToken,
  };

  const html = renderEmailConfirmacion(ctx);
  const text = renderEmailConfirmacionText(ctx);

  await transporter.sendMail({
    from: `"Natalia Jaramillo — ABBA Patrimonial" <${CONFIG.gmail.user}>`,
    to: session.client_email,
    subject: "Tu diagnóstico patrimonial está confirmado: aquí el enlace de Meet",
    html,
    text,
  });
  logger.info(`✉️  Confirmación enviada al cliente: ${session.client_email}`);
}

async function sendReagendamientoEmailToClient(transporter, session, sessionId) {
  const appUrlWithToken = sessionId
    ? `${CONFIG.appUrl}/?diag_session=${encodeURIComponent(sessionId)}`
    : CONFIG.appUrl;

  const ctx = {
    clientName: session.client_name,
    newSessionStart: session.session_start,
    originalSessionStart: session.original_session_start,
    meetLink: session.meet_link || "",
    appUrl: appUrlWithToken,
    reason: session.reschedule_reason || "",
    supportEmail: CONFIG.gmail.user,
  };

  await transporter.sendMail({
    from: `"Natalia Jaramillo — ABBA Patrimonial" <${CONFIG.gmail.user}>`,
    to: session.client_email,
    subject: "Tu sesión con Natalia fue reagendada",
    html: renderEmailReagendamiento(ctx),
    text: renderEmailReagendamientoText(ctx),
  });
  logger.info(`✉️  Email de reagendamiento enviado a: ${session.client_email}`);
}

async function sendReagendamientoEmailToNatalia(transporter, session) {
  const fmt = (d) => {
    if (!d) return "—";
    const date = d.toDate ? d.toDate() : new Date(d);
    return date.toLocaleString("es-CO", {
      timeZone: "America/Bogota",
      dateStyle: "full",
      timeStyle: "short",
    }).replace(/\s+a\.\s*m\./gi, " AM").replace(/\s+p\.\s*m\./gi, " PM");
  };

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;">
      <h3 style="color:#1e2853;margin:0 0 16px;">Sesión reagendada</h3>
      <table style="font-size:14px;color:#333;border-collapse:collapse;width:100%;">
        <tr><td style="padding:8px 12px;background:#f6f3ec;font-weight:600;width:180px;">Cliente</td>
            <td style="padding:8px 12px;">${session.client_name}</td></tr>
        <tr><td style="padding:8px 12px;background:#f6f3ec;font-weight:600;">Email</td>
            <td style="padding:8px 12px;"><a href="mailto:${session.client_email}">${session.client_email}</a></td></tr>
        <tr><td style="padding:8px 12px;background:#f6f3ec;font-weight:600;">Fecha original</td>
            <td style="padding:8px 12px;text-decoration:line-through;color:#888;">${fmt(session.original_session_start)}</td></tr>
        <tr><td style="padding:8px 12px;background:#f6f3ec;font-weight:600;">Nueva fecha</td>
            <td style="padding:8px 12px;color:#16a34a;font-weight:600;">${fmt(session.session_start)}</td></tr>
        <tr><td style="padding:8px 12px;background:#f6f3ec;font-weight:600;">Nuevo Meet link</td>
            <td style="padding:8px 12px;"><a href="${session.meet_link}" style="word-break:break-all;">${session.meet_link}</a></td></tr>
        <tr><td style="padding:8px 12px;background:#f6f3ec;font-weight:600;">Reagendado por</td>
            <td style="padding:8px 12px;">${session.rescheduled_by || "—"}</td></tr>
        ${session.reschedule_reason ? `
        <tr><td style="padding:8px 12px;background:#f6f3ec;font-weight:600;">Motivo</td>
            <td style="padding:8px 12px;">${session.reschedule_reason}</td></tr>` : ""}
      </table>
      <p style="font-size:13px;color:#666;margin:16px 0 0;">
        El cliente ya recibió el email con la nueva fecha y el nuevo enlace de Meet.
      </p>
    </div>`;

  await transporter.sendMail({
    from: `"Sistema ABBA" <${CONFIG.gmail.user}>`,
    to: CONFIG.natalia.email,
    subject: `Sesión reagendada: ${session.client_name}`,
    html,
    text: `Sesión de ${session.client_name} reagendada para ${fmt(session.session_start)}. Nuevo Meet: ${session.meet_link}`,
  });
  logger.info(`✉️  Aviso reagendamiento a Natalia: ${CONFIG.natalia.email}`);
}

async function sendConfirmationEmailToNatalia(transporter, session) {
  const html = renderEmailNotifSesionConfirmada({
    clientName: session.client_name,
    clientEmail: session.client_email,
    clientWhatsapp: session.client_whatsapp,
    clientMotivo: session.client_motivo,
    sessionStart: session.session_start,
    meetLink: session.meet_link || "",
  });

  await transporter.sendMail({
    from: `"Sistema ABBA" <${CONFIG.gmail.user}>`,
    to: CONFIG.natalia.email,
    subject: `Sesión confirmada: ${session.client_name}`,
    html,
    text: `Sesión confirmada de ${session.client_name}. Fecha: ${session.session_start}. Meet: ${session.meet_link}`,
  });
  logger.info(`✉️  Aviso enviado a Natalia: ${CONFIG.natalia.email}`);
}

// ─────────────────────────────────────────────────────────────────
//  linkDiagnosticSession — Callable
//  Vincula la cuenta autenticada del cliente en la app con su
//  diagnostico_session de Firestore. Se llama después del signup/login
//  cuando la app detectó un token pendiente en localStorage.
// ─────────────────────────────────────────────────────────────────
exports.linkDiagnosticSession = onCall(
  {
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 30,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesión primero.");
    }
    const uid = request.auth.uid;
    const userEmail =
      (request.auth.token && request.auth.token.email) || "";
    const sessionToken =
      request.data && typeof request.data.sessionToken === "string"
        ? request.data.sessionToken.trim()
        : "";

    if (!sessionToken) {
      throw new HttpsError("invalid-argument", "sessionToken es requerido.");
    }
    // Guardrail básico contra tokens malformados
    if (!/^[a-zA-Z0-9\-_]{8,}$/.test(sessionToken)) {
      throw new HttpsError("invalid-argument", "sessionToken con formato inválido.");
    }

    const sessionRef = db
      .collection("diagnostico_sessions")
      .doc(sessionToken);
    const sessionSnap = await sessionRef.get();
    if (!sessionSnap.exists) {
      throw new HttpsError(
        "not-found",
        "No encontramos esta sesión de diagnóstico."
      );
    }

    const session = sessionSnap.data();

    // Prevenir hijack: si ya está vinculada a otro usuario, bloquear
    if (session.linked_user_uid && session.linked_user_uid !== uid) {
      logger.warn(
        `🚫 Intento de re-vinculación bloqueado: session=${sessionToken}, ya vinculada a ${session.linked_user_uid}, intento por ${uid}`
      );
      throw new HttpsError(
        "permission-denied",
        "Esta sesión ya está vinculada a otra cuenta. Contacta soporte si crees que es un error."
      );
    }

    // Idempotencia: si ya está vinculada al mismo uid, devolvemos éxito sin escribir
    if (session.linked_user_uid === uid) {
      logger.info(`↩️  Vinculación ya existente para ${uid}, no-op`);
      return {
        success: true,
        alreadyLinked: true,
        sessionName: session.client_name,
        sessionEmail: session.client_email,
        sessionStart: session.session_start.toDate
          ? session.session_start.toDate().toISOString()
          : session.session_start,
      };
    }

    // Vincular ambos lados
    const now = new Date();
    await Promise.all([
      sessionRef.update({
        linked_user_uid: uid,
        linked_user_email: userEmail,
        linked_at: now,
      }),
      db
        .collection("clientes")
        .doc(uid)
        .set(
          {
            linked_session_id: sessionToken,
            linked_session_email: session.client_email,
            linked_session_at: now,
          },
          { merge: true }
        ),
    ]);

    logger.info(`🔗 Vinculado: session=${sessionToken} → uid=${uid}`);

    return {
      success: true,
      alreadyLinked: false,
      sessionName: session.client_name,
      sessionEmail: session.client_email,
      sessionStart: session.session_start.toDate
        ? session.session_start.toDate().toISOString()
        : session.session_start,
    };
  }
);

// ─────────────────────────────────────────────────────────────────
//  sendReminders12h — Recordatorio automático 12 horas antes
//  Corre cada 15 min. Busca sesiones confirmadas cuya session_start
//  está entre AHORA y AHORA+12h, y les envía un recordatorio.
//  Idempotente vía reminder_12h_sent_at.
// ─────────────────────────────────────────────────────────────────
exports.sendReminders12h = onSchedule(
  {
    region: "us-central1",
    schedule: "every 15 minutes",
    timeZone: "America/Bogota",
    secrets: ["GMAIL_PASSWORD"],
    memory: "256MiB",
    timeoutSeconds: 120,
  },
  async () => {
    const now = new Date();
    const in12h = new Date(now.getTime() + 12 * 60 * 60 * 1000);

    const snapshot = await db
      .collection("diagnostico_sessions")
      .where("status", "==", "confirmed")
      .where("session_start", ">", now)
      .where("session_start", "<=", in12h)
      .get();

    if (snapshot.empty) {
      logger.info("⏰ No hay sesiones para recordar en las próximas 12h.");
      return;
    }

    const transporter = makeTransporter();
    let sent = 0;
    let skipped = 0;

    for (const doc of snapshot.docs) {
      const data = doc.data();

      // Idempotencia: no re-procesar
      if (data.reminder_12h_sent_at) {
        skipped++;
        continue;
      }

      // ¿El cliente ya completó su diagnóstico en la app?
      let hasCompleted = false;
      try {
        hasCompleted = await hasCompletedDiagnostico(data);
      } catch (err) {
        logger.warn(
          `No se pudo verificar diagnóstico del cliente para sesión ${doc.id}:`,
          err
        );
      }

      if (hasCompleted) {
        // Cliente ya hizo la tarea: no enviar recordatorio, pero marcar como procesado
        await doc.ref.update({
          reminder_12h_sent_at: new Date(),
          reminder_12h_skipped_because: "client_completed_app",
        });
        logger.info(
          `✓ ${data.client_email} ya completó su diagnóstico, no se envía recordatorio.`
        );
        skipped++;
        continue;
      }

      const sessionToken = doc.id;
      const appUrlWithToken = sessionToken
        ? `${CONFIG.appUrl}/?diag_session=${encodeURIComponent(sessionToken)}`
        : CONFIG.appUrl;

      const ctx = {
        clientName: data.client_name,
        sessionStart: data.session_start.toDate
          ? data.session_start.toDate()
          : data.session_start,
        meetLink: data.meet_link || "",
        appUrl: appUrlWithToken,
        supportEmail: CONFIG.gmail.user,
      };

      try {
        await transporter.sendMail({
          from: `"Natalia Jaramillo — ABBA Patrimonial" <${CONFIG.gmail.user}>`,
          to: data.client_email,
          subject: "Recordatorio: tu sesión de diagnóstico se acerca",
          html: renderEmailRecordatorio12h(ctx),
          text: renderEmailRecordatorio12hText(ctx),
        });

        await doc.ref.update({
          reminder_12h_sent_at: new Date(),
        });

        logger.info(
          `⏰ Recordatorio 12h enviado a ${data.client_email} para sesión ${doc.id}`
        );
        sent++;
      } catch (err) {
        logger.error(`Error enviando recordatorio para ${doc.id}:`, err);
      }
    }

    logger.info(
      `⏰ Recordatorios 12h: ${sent} enviados, ${skipped} saltados.`
    );
  }
);

// ─────────────────────────────────────────────────────────────────
//  hasCompletedDiagnostico — Verifica si el cliente ya cargó los
//  módulos mínimos en la app antes de la sesión.
//
//  Consideramos que "completó" cuando:
//    1) linked_user_uid está seteado (vinculó su cuenta)
//    2) clientes/{uid} tiene perfil (nombre)
//    3) modulos/ingresos_gastos existe con fuentes_ingreso
//    4) modulos/activos existe (Mapa Patrimonial)
//
//  Si algo falla o no se puede verificar → retorna false y se envía
//  el recordatorio por precaución (mejor un recordatorio de más que
//  faltar cuando el cliente no lo hizo).
// ─────────────────────────────────────────────────────────────────
async function hasCompletedDiagnostico(sessionData) {
  const uid = sessionData.linked_user_uid;
  if (!uid) return false; // ni siquiera entró a la app

  // 1) Perfil básico
  const perfilSnap = await db.collection("clientes").doc(uid).get();
  if (!perfilSnap.exists) return false;
  const perfil = perfilSnap.data();
  if (!perfil || !perfil.nombre) return false;

  // 2) Módulos: ingresos_gastos + activos
  const [ingresosSnap, activosSnap] = await Promise.all([
    db
      .collection("clientes")
      .doc(uid)
      .collection("modulos")
      .doc("ingresos_gastos")
      .get(),
    db
      .collection("clientes")
      .doc(uid)
      .collection("modulos")
      .doc("activos")
      .get(),
  ]);

  if (!ingresosSnap.exists) return false;
  if (!activosSnap.exists) return false;

  // 3) Verificar que ingresos_gastos tenga al menos una fuente de ingreso
  //    (según Natalia: basta con que registre sus ingresos para evaluar
  //    las fuentes desde lo tributario)
  const ingresos = ingresosSnap.data();
  if (
    !ingresos ||
    !ingresos.fuentes_ingreso ||
    (Array.isArray(ingresos.fuentes_ingreso)
      ? ingresos.fuentes_ingreso.length === 0
      : Object.keys(ingresos.fuentes_ingreso).length === 0)
  ) {
    return false;
  }

  return true;
}