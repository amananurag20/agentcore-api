# Appointment Booking

The appointment module is the shared scheduling boundary for the standalone API,
voice receptionist, WhatsApp assistant, and customer chat.

## Scheduling rules

- Weekly staff availability is interpreted in each staff member's IANA timezone.
- API dates may include a `timezone`; returned instants are ISO timestamps.
- Daylight-saving gaps are rejected instead of silently shifting an appointment.
- Staff time off, service buffers, resource time off, staff-resource mappings, and
  shared resource capacity participate in availability and booking conflicts.
- Booking and rescheduling conflict checks run in serializable transactions with
  bounded retries; a concurrent winner produces HTTP `409` for the loser.

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

Run both processes in production:

```bash
npm run start:prod
npm run start:worker
```

Email uses Resend, SMS uses Twilio, and WhatsApp uses the organization's active
Meta/Twilio configuration. See `.env.example` and
`docs/production-integrations-checklist.md` for required settings.
