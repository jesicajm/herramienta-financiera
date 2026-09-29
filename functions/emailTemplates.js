/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  EMAIL TEMPLATES — Diagnóstico patrimonial con Natalia       ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║  renderEmailInstruccionesPago(ctx)     — HTML con datos de   ║
 * ║                                          pago + WhatsApp CTA ║
 * ║  renderEmailInstruccionesPagoText(ctx) — Fallback texto plano║
 * ║  renderEmailExpiracion(ctx)            — Aviso de expiración ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 *  ctx esperado en renderEmailInstruccionesPago:
 *    - clientName:      string
 *    - sessionStart:    Date
 *    - paymentDeadline: Date
 *    - paymentInfo:     objeto tomado de config/payment_info en Firestore
 *        { bank_name, account_type, account_number, account_holder,
 *          account_holder_id, amount, whatsapp_number,
 *          whatsapp_agent_name, support_email }
 */

// ─────────────────────────────────────────────────────────────────
//  PALETA ABBA
// ─────────────────────────────────────────────────────────────────
const COLORS = {
  navy: "#1e2853",
  brand: "#10578f",
  cream: "#f6f3ec",
  ink: "#1a1a1a",
  muted: "#5d6a7d",
  whatsapp: "#25D366",
  alert: "#c0392b",
  border: "#e2e0d8",
};

// ─────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────
function formatBogota(date) {
  if (!(date instanceof Date)) date = new Date(date);
  return date.toLocaleString("es-CO", {
    timeZone: "America/Bogota",
    dateStyle: "full",
    timeStyle: "short",
  });
}

function formatCOP(n) {
  if (n === null || n === undefined) return "";
  return "$" + Number(n).toLocaleString("es-CO");
}

function whatsappUrl(phone, message) {
  const clean = String(phone || "").replace(/[^\d]/g, "");
  const encoded = encodeURIComponent(message);
  return `https://wa.me/${clean}?text=${encoded}`;
}

// ─────────────────────────────────────────────────────────────────
//  EMAIL 1 — INSTRUCCIONES DE PAGO (HTML)
// ─────────────────────────────────────────────────────────────────
function renderEmailInstruccionesPago(ctx) {
  const {
    clientName = "",
    sessionStart,
    paymentDeadline,
    paymentInfo = {},
  } = ctx;

  const amount = paymentInfo.amount || 150000;
  const bankName = paymentInfo.bank_name || "Bancolombia";
  const accountType = paymentInfo.account_type || "Ahorros";
  const accountNumber = paymentInfo.account_number || "";
  const accountHolder =
    paymentInfo.account_holder || "Natalia Jaramillo Consultora";
  const accountHolderId = paymentInfo.account_holder_id || "";
  const whatsappNumber = paymentInfo.whatsapp_number || "573001234567";
  const whatsappAgent =
    paymentInfo.whatsapp_agent_name || "Jessica Jaramillo";
  const supportEmail =
    paymentInfo.support_email || "hola@abbapatrimonial.com";

  const waMessage = `Hola ${whatsappAgent}, envío el comprobante de mi diagnóstico patrimonial con Natalia agendado para ${formatBogota(
    sessionStart
  )}. Nombre: ${clientName}.`;

  const waLink = whatsappUrl(whatsappNumber, waMessage);

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Confirma tu diagnóstico patrimonial</title>
</head>
<body style="margin:0;padding:0;background:${COLORS.cream};font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:${COLORS.ink};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.cream};padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid ${COLORS.border};border-radius:8px;overflow:hidden;">

        <!-- Header -->
        <tr>
          <td style="background:${COLORS.navy};padding:32px 32px 24px;text-align:center;">
            <p style="margin:0 0 8px;font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#c9d3e6;">
              ABBA Patrimonial
            </p>
            <h1 style="margin:0;font-size:22px;font-weight:400;color:#ffffff;line-height:1.35;">
              Reservaste tu diagnóstico patrimonial<br>con Natalia
            </h1>
          </td>
        </tr>

        <!-- Cuerpo -->
        <tr>
          <td style="padding:32px;">
            <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:${COLORS.ink};">
              Hola <strong>${clientName}</strong>,
            </p>
            <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:${COLORS.ink};">
              Recibimos tu solicitud de sesión para el
              <strong>${formatBogota(sessionStart)}</strong>.
              Para confirmarla, necesitamos el pago dentro de las próximas 3 horas:
            </p>

            <!-- Deadline -->
            <div style="background:${COLORS.cream};border-left:3px solid ${COLORS.alert};padding:14px 18px;margin:0 0 24px;border-radius:0 4px 4px 0;">
              <p style="margin:0;font-size:12px;letter-spacing:0.15em;text-transform:uppercase;color:${COLORS.alert};font-weight:600;">
                Fecha límite de pago
              </p>
              <p style="margin:4px 0 0;font-size:15px;color:${COLORS.ink};font-weight:500;">
                ${formatBogota(paymentDeadline)}
              </p>
              <p style="margin:6px 0 0;font-size:13px;color:${COLORS.muted};">
                Si no recibimos el comprobante antes de esa hora, el horario se libera automáticamente para otro cliente.
              </p>
            </div>

            <!-- Datos de la cuenta -->
            <h2 style="margin:0 0 12px;font-size:13px;letter-spacing:0.18em;text-transform:uppercase;color:${COLORS.brand};font-weight:600;">
              Datos para la transferencia
            </h2>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 24px;">
              <tr>
                <td style="padding:10px 14px;background:${COLORS.cream};font-size:13px;color:${COLORS.muted};width:150px;">Banco</td>
                <td style="padding:10px 14px;background:${COLORS.cream};font-size:14px;color:${COLORS.ink};font-weight:500;">${bankName}</td>
              </tr>
              <tr>
                <td style="padding:10px 14px;font-size:13px;color:${COLORS.muted};">Tipo de cuenta</td>
                <td style="padding:10px 14px;font-size:14px;color:${COLORS.ink};font-weight:500;">${accountType}</td>
              </tr>
              <tr>
                <td style="padding:10px 14px;background:${COLORS.cream};font-size:13px;color:${COLORS.muted};">Número de cuenta</td>
                <td style="padding:10px 14px;background:${COLORS.cream};font-size:14px;color:${COLORS.ink};font-weight:500;font-family:'Courier New',monospace;">${accountNumber}</td>
              </tr>
              <tr>
                <td style="padding:10px 14px;font-size:13px;color:${COLORS.muted};">Titular</td>
                <td style="padding:10px 14px;font-size:14px;color:${COLORS.ink};font-weight:500;">${accountHolder}</td>
              </tr>
              ${
                accountHolderId
                  ? `<tr>
                      <td style="padding:10px 14px;background:${COLORS.cream};font-size:13px;color:${COLORS.muted};">Documento</td>
                      <td style="padding:10px 14px;background:${COLORS.cream};font-size:14px;color:${COLORS.ink};font-weight:500;">${accountHolderId}</td>
                    </tr>`
                  : ""
              }
              <tr>
                <td style="padding:14px;background:${COLORS.navy};color:#c9d3e6;font-size:13px;letter-spacing:0.05em;text-transform:uppercase;">Valor a transferir</td>
                <td style="padding:14px;background:${COLORS.navy};color:#ffffff;font-size:20px;font-weight:600;">${formatCOP(amount)} COP</td>
              </tr>
            </table>

            <!-- WhatsApp CTA -->
            <h2 style="margin:0 0 12px;font-size:13px;letter-spacing:0.18em;text-transform:uppercase;color:${COLORS.brand};font-weight:600;">
              Envía tu comprobante
            </h2>
            <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:${COLORS.ink};">
              Después de la transferencia, envía el comprobante por WhatsApp a <strong>${whatsappAgent}</strong>.
              El mensaje ya viene armado con tus datos:
            </p>

            <div style="text-align:center;margin:0 0 24px;">
              <a href="${waLink}"
                 style="display:inline-block;background:${COLORS.whatsapp};color:#ffffff;
                        text-decoration:none;font-size:15px;font-weight:600;letter-spacing:0.03em;
                        padding:14px 32px;border-radius:6px;">
                Enviar comprobante por WhatsApp →
              </a>
            </div>

            <!-- Qué sigue -->
            <h2 style="margin:0 0 12px;font-size:13px;letter-spacing:0.18em;text-transform:uppercase;color:${COLORS.brand};font-weight:600;">
              Qué sigue
            </h2>
            <ol style="margin:0 0 24px;padding-left:20px;font-size:14px;line-height:1.7;color:${COLORS.ink};">
              <li>Hacés la transferencia por ${formatCOP(amount)} COP.</li>
              <li>Enviás el comprobante por WhatsApp con el botón de arriba.</li>
              <li>${whatsappAgent} valida el pago y te envía por email el enlace de Google Meet para la sesión.</li>
              <li>Nos vemos en la sesión el ${formatBogota(sessionStart)}.</li>
            </ol>

            <p style="margin:0 0 8px;font-size:13px;color:${COLORS.muted};line-height:1.6;">
              Si tenés cualquier duda sobre el pago, escribinos a
              <a href="mailto:${supportEmail}" style="color:${COLORS.brand};text-decoration:none;">${supportEmail}</a>.
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:${COLORS.cream};padding:24px 32px;text-align:center;border-top:1px solid ${COLORS.border};">
            <p style="margin:0;font-size:13px;color:${COLORS.navy};font-weight:600;">
              Natalia Jaramillo
            </p>
            <p style="margin:4px 0 0;font-size:12px;color:${COLORS.muted};">
              ABBA · Arquitectura Patrimonial
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────
//  EMAIL 1 — FALLBACK TEXTO PLANO
// ─────────────────────────────────────────────────────────────────
function renderEmailInstruccionesPagoText(ctx) {
  const {
    clientName = "",
    sessionStart,
    paymentDeadline,
    paymentInfo = {},
  } = ctx;

  const amount = paymentInfo.amount || 150000;
  const bankName = paymentInfo.bank_name || "Bancolombia";
  const accountType = paymentInfo.account_type || "Ahorros";
  const accountNumber = paymentInfo.account_number || "";
  const accountHolder =
    paymentInfo.account_holder || "Natalia Jaramillo Consultora";
  const accountHolderId = paymentInfo.account_holder_id || "";
  const whatsappNumber = paymentInfo.whatsapp_number || "573001234567";
  const whatsappAgent =
    paymentInfo.whatsapp_agent_name || "Jessica Jaramillo";
  const supportEmail =
    paymentInfo.support_email || "hola@abbapatrimonial.com";

  const waMessage = `Hola ${whatsappAgent}, envío el comprobante de mi diagnóstico patrimonial con Natalia agendado para ${formatBogota(
    sessionStart
  )}. Nombre: ${clientName}.`;
  const waLink = whatsappUrl(whatsappNumber, waMessage);

  return `Hola ${clientName},

Recibimos tu solicitud de diagnóstico patrimonial para el ${formatBogota(sessionStart)}.

Para confirmarla, necesitamos tu pago antes de:
  ${formatBogota(paymentDeadline)}

Si no recibimos el comprobante antes de esa hora, el horario se libera automáticamente.

DATOS PARA LA TRANSFERENCIA
  Banco:            ${bankName}
  Tipo de cuenta:   ${accountType}
  Número:           ${accountNumber}
  Titular:          ${accountHolder}${
    accountHolderId ? `\n  Documento:        ${accountHolderId}` : ""
  }
  Valor:            ${formatCOP(amount)} COP

DESPUÉS DE PAGAR
Envía el comprobante por WhatsApp a ${whatsappAgent}:
  ${waLink}

QUÉ SIGUE
  1. Hacés la transferencia por ${formatCOP(amount)} COP.
  2. Enviás el comprobante por el link de WhatsApp de arriba.
  3. ${whatsappAgent} valida el pago y te envía por email el enlace de Google Meet.
  4. Nos vemos en la sesión el ${formatBogota(sessionStart)}.

Cualquier duda: ${supportEmail}

Un abrazo,
Natalia Jaramillo
ABBA Patrimonial
`;
}

// ─────────────────────────────────────────────────────────────────
//  EMAIL 2 — EXPIRACIÓN DE RESERVA
// ─────────────────────────────────────────────────────────────────
function renderEmailExpiracion(ctx) {
  const { clientName = "", calendlyUrl = "" } = ctx || {};

  const ctaBlock = calendlyUrl
    ? `
          <div style="text-align:center;margin:8px 0 24px;">
            <a href="${calendlyUrl}"
               style="display:inline-block;background:${COLORS.brand};color:#ffffff;
                      text-decoration:none;font-size:15px;font-weight:600;letter-spacing:0.03em;
                      padding:14px 32px;border-radius:6px;">
              Volver a agendar mi diagnóstico →
            </a>
            <p style="margin:12px 0 0;font-size:12px;color:${COLORS.muted};">
              El horario que reservaste ya está liberado para que puedas elegir uno nuevo.
            </p>
          </div>`
    : "";

  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8" /></head>
<body style="margin:0;padding:0;background:${COLORS.cream};font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:${COLORS.ink};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.cream};padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid ${COLORS.border};border-radius:8px;">
        <tr><td style="padding:32px;">
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;">Hola <strong>${clientName}</strong>,</p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:${COLORS.ink};">
            No recibimos el comprobante de pago dentro de las 3 horas posteriores a tu reserva, así que liberamos el horario para otros clientes.
          </p>
          <p style="margin:0 0 20px;font-size:15px;line-height:1.65;color:${COLORS.ink};">
            Si querés retomar el proceso, podés volver a agendar cuando estés listo/a. Si tuviste algún inconveniente con el pago, respondé este correo y te ayudamos.
          </p>
          ${ctaBlock}
          <p style="margin:0;font-size:14px;color:${COLORS.muted};">Un abrazo,</p>
          <p style="margin:6px 0 0;font-size:14px;font-weight:600;color:${COLORS.navy};">Natalia Jaramillo</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────
//  EMAIL 3 — CONFIRMACIÓN DE SESIÓN (con Meet link)
// ─────────────────────────────────────────────────────────────────
function renderEmailConfirmacion(ctx) {
  const {
    clientName = "",
    sessionStart,
    meetLink = "",
    eventName = "Diagnóstico patrimonial",
    supportEmail = "hola@abbapatrimonial.com",
  } = ctx;

  const meetBlock = meetLink
    ? `
        <div style="background:${COLORS.cream};border:1px solid ${COLORS.border};border-radius:8px;padding:20px;margin:0 0 24px;text-align:center;">
          <p style="margin:0 0 10px;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:${COLORS.brand};font-weight:600;">
            Enlace de Google Meet
          </p>
          <p style="margin:0 0 16px;font-size:14px;color:${COLORS.muted};line-height:1.5;">
            Este es el link para entrar a tu sesión el día y hora agendados:
          </p>
          <a href="${meetLink}"
             style="display:inline-block;background:${COLORS.brand};color:#ffffff;
                    text-decoration:none;font-size:15px;font-weight:600;
                    padding:14px 32px;border-radius:6px;">
            Entrar a la sesión de Meet →
          </a>
          <p style="margin:14px 0 0;font-size:12px;color:${COLORS.muted};word-break:break-all;">
            ${meetLink}
          </p>
        </div>`
    : `
        <div style="background:${COLORS.cream};border-left:3px solid ${COLORS.alert};padding:14px 18px;margin:0 0 24px;border-radius:0 4px 4px 0;">
          <p style="margin:0;font-size:14px;color:${COLORS.alert};font-weight:600;">
            El enlace de la sesión te llegará por separado.
          </p>
          <p style="margin:6px 0 0;font-size:13px;color:${COLORS.muted};">
            Natalia te lo va a compartir minutos antes del encuentro.
          </p>
        </div>`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Tu diagnóstico patrimonial está confirmado</title>
</head>
<body style="margin:0;padding:0;background:${COLORS.cream};font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:${COLORS.ink};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.cream};padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid ${COLORS.border};border-radius:8px;overflow:hidden;">

        <tr>
          <td style="background:${COLORS.navy};padding:32px 32px 24px;text-align:center;">
            <p style="margin:0 0 8px;font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#c9d3e6;">
              ABBA Patrimonial
            </p>
            <h1 style="margin:0;font-size:22px;font-weight:400;color:#ffffff;line-height:1.35;">
              ${clientName}, tu sesión<br>está confirmada ✓
            </h1>
          </td>
        </tr>

        <tr>
          <td style="padding:32px;">
            <p style="margin:0 0 16px;font-size:15px;line-height:1.65;">
              Recibimos tu comprobante de pago. Nos vemos el:
            </p>

            <div style="background:${COLORS.navy};color:#ffffff;padding:20px 24px;border-radius:8px;margin:0 0 24px;text-align:center;">
              <p style="margin:0 0 4px;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#c9d3e6;">
                Fecha de la sesión
              </p>
              <p style="margin:0;font-size:18px;font-weight:500;color:#ffffff;line-height:1.4;">
                ${formatBogota(sessionStart)}
              </p>
              <p style="margin:8px 0 0;font-size:12px;color:#c9d3e6;">
                Duración: 60 minutos
              </p>
            </div>

            ${meetBlock}

            <h2 style="margin:0 0 12px;font-size:13px;letter-spacing:0.18em;text-transform:uppercase;color:${COLORS.brand};font-weight:600;">
              Cómo llegar bien preparado/a
            </h2>
            <ul style="margin:0 0 24px;padding-left:20px;font-size:14px;line-height:1.7;color:${COLORS.ink};">
              <li>Ten a mano una idea general de tu patrimonio actual (inmuebles, inversiones, empresa, deudas).</li>
              <li>Un resumen de tus ingresos y gastos mensuales aproximados.</li>
              <li>Cualquier decisión patrimonial que estés considerando (compra, herencia, sociedad, jubilación).</li>
              <li>Preguntas concretas — no hace falta que sean sofisticadas, cuanto más específicas mejor.</li>
            </ul>

            <p style="margin:0 0 16px;font-size:14px;line-height:1.65;color:${COLORS.ink};">
              La sesión es una conversación de trabajo, no un pitch. Sales con un mapa concreto de tu situación y las 2 o 3 palancas que más mueven la aguja en tu caso.
            </p>

            <p style="margin:0 0 8px;font-size:13px;color:${COLORS.muted};line-height:1.6;">
              Si necesitás reprogramar o tenés cualquier duda, respondé este correo o escribinos a
              <a href="mailto:${supportEmail}" style="color:${COLORS.brand};text-decoration:none;">${supportEmail}</a>.
            </p>
          </td>
        </tr>

        <tr>
          <td style="background:${COLORS.cream};padding:24px 32px;text-align:center;border-top:1px solid ${COLORS.border};">
            <p style="margin:0;font-size:13px;color:${COLORS.navy};font-weight:600;">
              Natalia Jaramillo
            </p>
            <p style="margin:4px 0 0;font-size:12px;color:${COLORS.muted};">
              ABBA Patrimonial · Arquitectura de patrimonio
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function renderEmailConfirmacionText(ctx) {
  const {
    clientName = "",
    sessionStart,
    meetLink = "",
    supportEmail = "hola@abbapatrimonial.com",
  } = ctx;

  return `${clientName}, tu sesión de diagnóstico patrimonial está confirmada.

FECHA DE LA SESIÓN
  ${formatBogota(sessionStart)}
  Duración: 60 minutos

ENLACE DE GOOGLE MEET
  ${meetLink || "(te lo compartimos por separado)"}

CÓMO LLEGAR PREPARADO/A
  - Ten a mano una idea general de tu patrimonio actual (inmuebles, inversiones, empresa, deudas).
  - Un resumen de tus ingresos y gastos mensuales aproximados.
  - Cualquier decisión patrimonial que estés considerando.
  - Preguntas concretas — cuanto más específicas mejor.

La sesión es una conversación de trabajo, no un pitch. Sales con un mapa concreto de tu situación y las 2 o 3 palancas que más mueven la aguja en tu caso.

Si necesitás reprogramar o tenés dudas, respondé este correo o escribinos a ${supportEmail}.

Un abrazo,
Natalia Jaramillo
ABBA Patrimonial
`;
}

// ─────────────────────────────────────────────────────────────────
//  EMAIL 4 — NOTIFICACIÓN INTERNA A NATALIA (sesión confirmada)
// ─────────────────────────────────────────────────────────────────
function renderEmailNotifSesionConfirmada(ctx) {
  const {
    clientName = "",
    clientEmail = "",
    clientWhatsapp = "",
    clientMotivo = "",
    sessionStart,
    meetLink = "",
  } = ctx;

  const motivoHtml = clientMotivo
    ? `<div style="background:${COLORS.cream};border-left:3px solid ${COLORS.brand};padding:14px 18px;margin:16px 0 0;border-radius:0 4px 4px 0;">
         <p style="margin:0 0 6px;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:${COLORS.brand};font-weight:600;">
           Lo que trae el cliente
         </p>
         <p style="margin:0;font-size:14px;color:${COLORS.ink};line-height:1.6;white-space:pre-wrap;">${clientMotivo}</p>
       </div>`
    : "";

  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8" /></head>
<body style="margin:0;padding:0;background:${COLORS.cream};font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:${COLORS.ink};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.cream};padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid ${COLORS.border};border-radius:8px;">
        <tr><td style="padding:28px 32px;">
          <p style="margin:0 0 6px;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:${COLORS.brand};font-weight:600;">
            Sesión confirmada
          </p>
          <h2 style="margin:0 0 20px;font-size:20px;font-weight:500;color:${COLORS.navy};line-height:1.35;">
            ${clientName}
          </h2>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;color:${COLORS.ink};">
            <tr><td style="padding:8px 12px;background:${COLORS.cream};font-weight:600;width:140px;">Fecha</td>
                <td style="padding:8px 12px;border-bottom:1px solid ${COLORS.border};">${formatBogota(sessionStart)}</td></tr>
            <tr><td style="padding:8px 12px;background:${COLORS.cream};font-weight:600;">Email</td>
                <td style="padding:8px 12px;border-bottom:1px solid ${COLORS.border};"><a href="mailto:${clientEmail}" style="color:${COLORS.brand};">${clientEmail}</a></td></tr>
            <tr><td style="padding:8px 12px;background:${COLORS.cream};font-weight:600;">WhatsApp</td>
                <td style="padding:8px 12px;border-bottom:1px solid ${COLORS.border};">${clientWhatsapp || "(no dejó)"}</td></tr>
            ${
              meetLink
                ? `<tr><td style="padding:8px 12px;background:${COLORS.cream};font-weight:600;">Meet link</td>
                       <td style="padding:8px 12px;border-bottom:1px solid ${COLORS.border};">
                         <a href="${meetLink}" style="color:${COLORS.brand};word-break:break-all;">${meetLink}</a>
                       </td></tr>`
                : ""
            }
          </table>

          ${motivoHtml}

          <p style="margin:24px 0 0;font-size:13px;color:${COLORS.muted};line-height:1.6;">
            El cliente ya recibió el email con los datos de la sesión y el enlace de Meet.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

module.exports = {
  renderEmailInstruccionesPago,
  renderEmailInstruccionesPagoText,
  renderEmailExpiracion,
  renderEmailConfirmacion,
  renderEmailConfirmacionText,
  renderEmailNotifSesionConfirmada,
};