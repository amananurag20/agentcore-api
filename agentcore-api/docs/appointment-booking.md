# Appointment Booking

The appointment module is the shared scheduling boundary for the standalone API,
voice receptionist, WhatsApp assistant, and customer chat.

## Scheduling rules

- Weekly staff availability is interpreted in each staff member's IANA timezone.
- API dates may include a `timezone`; returned instants are ISO timestamps.
- Daylight-saving gaps are rejected instead of silently shifting an appointment.
- Staff time off, service buffers, resource time off, staff-resource mappings, and
  shared resource capacity participate in availability and booking conflicts.
- Organization blackouts apply to every staff member and may be one-off or annual.
- Services may set `maxAttendees`; exact group sessions share seats and availability
  returns `seatsRemaining`. Partially overlapping group sessions remain forbidden.
- Booking and rescheduling conflict checks run in serializable transactions with
  bounded retries. PostgreSQL exclusion/capacity guards remain the final backstop,
  and a concurrent winner produces HTTP `409` for the loser.

## Policies, attendance, and closures

Administrators manage organization defaults through `GET/PATCH
/api/v1/appointment-booking/policy`. Services may override public cancellation
and reschedule windows. Authenticated staff/admin actions bypass these customer
self-service windows.

The policy also stores the organization reminder schedule and templates.
`reminderOffsetsMinutes` contains positive minute offsets before the appointment;
the immediate confirmation is always added separately. Services can override the
schedule and templates with the same fields, while empty service settings inherit
the organization policy. Template keys include `confirmation`, `reminder`, a
specific type such as `24h_before`, `emailSubject`, and
`whatsappTemplateName`. Text supports `{{customerName}}`, `{{serviceName}}`,
`{{staffName}}`, `{{startTime}}`, `{{partySize}}`, `{{reminderType}}`, and
`{{preferencesUrl}}`.

Use `PATCH /api/v1/appointment-booking/bookings/:id/check-in` to record attendance.
The worker marks unchecked-in confirmed bookings `no_show` after the configured
grace period. Organization closures are managed through the authenticated
`/appointment-booking/blackouts` endpoints.

## Recurring appointments

Booking creation accepts a bounded recurrence rule (`daily`, `weekly`, or
`monthly`, interval, and 2-52 occurrences). All occurrences are availability-
checked and created atomically in a recurrence series. Existing reschedule APIs
change one occurrence by default; `applyToFuture=true` shifts that occurrence and
all later ones atomically. Series cancellation supports the whole series or a
`fromOccurrenceIndex` through authenticated and management-token public routes.

## Waitlist

Customers may join a full service/staff/start slot at `POST
/api/v1/appointment-booking/public/waitlist`. Cancellation offers the released
capacity to the first party that fits, by email/SMS, with a configurable claim
deadline. Claims are optimistic and DB-capacity guarded. The worker expires stale
offers, repairs interrupted claims, and advances the queue.

Public clients can query `GET
/api/v1/appointment-booking/public/waitlist-sessions` with the same parameters
as availability. It returns already-booked sessions, including sessions with no
remaining seats, so customers can choose a waitlist session without knowing an
internal staff ID.

## Customer self-service

Public booking creation returns `manageToken` once. Only its SHA-256 hash is
stored. The token and organization ID are required for public reschedule/cancel:

- `PATCH /api/v1/appointment-booking/public/bookings/:id/reschedule`
- `PATCH /api/v1/appointment-booking/public/bookings/:id/cancel`

Treat the management token like a password. It is intentionally omitted from
all subsequent responses and list endpoints.

## Channel actions

Authenticated orchestrators call
`POST /api/v1/appointment-booking/actions/execute`. The same
`AppointmentActionDto` may be supplied as `appointmentAction` in customer-chat
message bodies or as `metadata.appointmentAction` in voice/WhatsApp webhook
events. Supported actions are:

- `list_services`
- `list_availability`
- `book`
- `reschedule`
- `cancel`

Channels receive the same conflict, entitlement, timezone, resource, and token
checks as the standalone API.

## Reminders

Every reminder is persisted before it is published to BullMQ. Jobs are versioned
by due time, so stale reschedule jobs cannot send early. The worker claims each
record atomically, tracks attempts/provider IDs/errors, skips inactive bookings,
and periodically recovers publish or delivery failures.

Organization quiet hours shift non-confirmation reminders to the next permitted
wall-clock time (and drop the reminder if that would be after the appointment).
Reminder messages include an HMAC-signed preference link when
`APPOINTMENT_PUBLIC_URL` is configured. The public opt-out endpoint creates a
per-channel suppression that is checked immediately before delivery.

## Operations and deployment

Administrators inspect terminal delivery failures with `GET
/api/v1/appointment-booking/operations/dead-letters`. Retry a reminder with
`POST /operations/reminders/:id/retry` or a calendar event with `POST
/operations/calendars/:id/retry`. Retries reset recovery attempts, enqueue a new
idempotent job, and create an audit event.
Set `APPOINTMENT_OPERATIONS_ALERT_WEBHOOK_URL` to receive a bounded-time JSON
webhook as soon as a reminder or calendar record enters dead letter.

Before production traffic, apply all Prisma migrations, run the API and worker as
separately supervised processes, configure Redis and provider credentials, set
`APPOINTMENT_PUBLIC_URL`, and alert on dead-letter audit events plus queue/worker
health. Live Google, Microsoft, SMTP, Twilio, and Meta verification requires
credentials for the target environment.

Run both processes in production:

```bash
npm run start:prod
npm run start:worker
```

Email uses Nodemailer with SMTP, SMS uses Twilio, and WhatsApp uses the organization's active
Meta/Twilio configuration. See `.env.example` and
`docs/production-integrations-checklist.md` for required settings.

## Google Calendar and Microsoft Outlook

Organization administrators connect a provider to an appointment staff member
through the Calendar sync tab or these authenticated endpoints:

- `GET /api/v1/appointment-booking/calendars/connections`
- `POST /api/v1/appointment-booking/calendars/connections`
- `DELETE /api/v1/appointment-booking/calendars/connections/:id`

OAuth state is random, short-lived, and stored only as a SHA-256 hash. Access and
refresh tokens are encrypted with `AI_CONFIG_ENCRYPTION_KEY` and never returned by
the API. Connected calendars participate in availability through Google FreeBusy
or Microsoft Graph calendarView. The default is fail-open: a provider outage is
recorded on the connection but does not take down public availability or booking.
Set `APPOINTMENT_CALENDAR_FAIL_OPEN=false` to choose strict fail-closed behavior.

Booking creates, reschedules, cancellations, and status changes produce durable,
versioned BullMQ sync records. Failed records are retried and recovered by the
worker. Connecting a calendar also backfills future pending/confirmed bookings.
Run `npm run start:worker` with the API.

Provider setup:

1. Create a Google OAuth web client and/or Microsoft Entra web application.
2. Register the exact callback URLs from `GOOGLE_CALENDAR_REDIRECT_URI` and
   `MICROSOFT_CALENDAR_REDIRECT_URI`.
3. Configure the client IDs/secrets and the frontend return URL shown in
   `.env.example`.
4. For Microsoft, grant delegated `User.Read` and `Calendars.ReadWrite`; for
   Google, enable Calendar API access and the calendar OAuth scope.
