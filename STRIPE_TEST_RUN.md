# Stripe test-mode acceptance run
_A step-by-step checklist for the owner. About an hour the first time._

## What this is

Until now every payment test has run against a simulation of Stripe that we wrote ourselves. This run is the first time our code meets the real Stripe, in TEST mode, where no real money moves.

It proves that Stripe accepts what our system sends: practitioner payout setup, the checkout, Stripe's confirmation message, the processing fee we read, a refund, and the payout to the practitioner.

It does not prove: live mode with real money; practitioners outside the US (see the last section); or the email provider (emails are only printed in this run).

It is safe by design. The scripts refuse live keys, the checker only reads, and test mode moves no real money.

## What you need

- A Stripe account in test mode with Connect switched on (you said it is).
- Your TEST secret key: Stripe Dashboard, Developers, API keys, the secret key that starts with sk_test_. Never paste it into a chat or an email.
- The Stripe command-line tool (docs.stripe.com/stripe-cli), logged in with: stripe login
- Node.js 20 or newer, and PostgreSQL running on your computer.
- The two zip files, unzipped: the backend (AIDH_Backend_Scaffold_v0.5) and the front end (AIDH_Frontend_Final).

## Step 1. Prepare the backend

In a terminal, in the backend folder:

```
npm install
createdb aidh_stripe_test
```

Create a file named .env in that folder containing the lines below. Use a TEST database only, never a real one.

```
DATABASE_URL=postgres://localhost:5432/aidh_stripe_test
JWT_SECRET=make-up-a-long-random-string
FIELD_ENCRYPTION_KEY=64-hex-characters (make one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
STRIPE_SECRET_KEY=sk_test_your_test_key
STRIPE_WEBHOOK_SECRET=filled-in-at-step-2
MAIL_PROVIDER=console
CONSULTATION_RETURN_URL=http://localhost:4001/aidh_book.html
CONNECT_RETURN_URL=http://localhost:4001/aidh_practitioner_console.html
CONSULTATION_RELEASE_DELAY_HOURS=0
```

Then create the tables:

```
npm run migrate
npm run seed
```

## Step 2. Start the system, and Stripe's message forwarder

Open two terminals in the backend folder.

- Terminal A starts the pages and the server together, on one address. Use the full path to the unzipped front-end folder.

```
npm run local-stack -- --frontend /full/path/to/the/unzipped/frontend
```

Terminal B forwards Stripe's confirmation messages to your computer:

```
stripe listen --forward-to localhost:4001/api/billing/webhook --events checkout.session.completed,checkout.session.expired
```

Terminal B prints a line saying your webhook signing secret is whsec_... Copy it into the .env file as STRIPE_WEBHOOK_SECRET, then stop Terminal A (Ctrl-C) and start it again with the same command. Leave Terminal B running for the whole run.

## Step 3. Pre-flight check

```
npm run stripe:check-env
```

You should see no FAIL lines. WARN lines are notes. If something fails, the line says what to fix; fix it and run the check again. The check refuses a live key and sends nothing to Stripe in that case.

## Step 4. Make the test practitioner and set them up

```
npm run seed:test-practitioner -- --email prac@test.local --password 'Choose-A-Long-Password-9'
```

In a browser open http://localhost:4001/aidh_website.html, accept the entry notice, choose Sign in, and sign in as prac@test.local. Then open http://localhost:4001/aidh_practitioner_console.html and work down the sections:

1. Practitioner Agreement: tick the box and press Accept (it is the marked draft).
2. Public directory: tick the agreement box and press Save.
3. Sessions and pricing: price 40.00, Premium price 30.00, 30 minutes, tick Accept bookings, Save.
4. Your video room: any https link, for example https://meet.google.com/abc-defg-hij, tick the box, Save link.
5. Weekly hours: press Add hours on every day, Save hours.
6. Payouts: press Set up payouts with Stripe. Stripe's own page opens. In test mode it offers shortcuts for filling in test details (Stripe's testing page lists the values). Finish, return to the console, press Check status.

You should see the green banner: You are live.

## Step 5. Make a booking and pay

In a second browser window (a private window is easiest), open the website and create a free subscriber account with any email. Open the booking page, choose Test Practitioner, choose a time at least three days ahead, tick the box, and press Continue to payment. On Stripe's page use:

- Card number 4000 0000 0000 0077 (it adds the money straight to the available balance, so the payout step can work at once)
- Any future expiry date, any 3-digit security code, any postcode

You should see: back on our page within a few seconds, Your consultation is confirmed, with a join link. In Terminal A the two confirmation emails are printed. In Terminal B a line shows checkout.session.completed with 200.

If the page says it has not received confirmation, look at Terminal B for a failed delivery. The usual cause is a wrong STRIPE_WEBHOOK_SECRET.

## Step 6. Check what Stripe recorded

```
npm run verify:stripe-run
```

This only reads. It compares our records with Stripe's: the payment succeeded, the amount, that the fee we recorded equals the fee Stripe charged, and that nothing was refunded. You should see OK on every line for this booking.

## Step 7. Cancel and check the refund

In My consultations open the booking and press Cancel. The confirmation shows the exact refund: the payment minus the processing fee. Accept it, then run the check again:

```
npm run verify:stripe-run
```

You should see the refund line OK: the amount Stripe refunded equals what we recorded. In the Stripe Dashboard (test mode), Payments, that payment shows a partial refund. Then repeat Step 5 once more, to make a booking for the payout test.

## Step 8. Check the payout to the practitioner

This pretends the session has already happened, by moving the booking's times into the past. TEST DATABASE ONLY. Never run it on a real database.

```
psql "$DATABASE_URL" -c "UPDATE consultation_bookings SET starts_at = now() - interval '2 hours', ends_at = now() - interval '90 minutes', release_after = now() - interval '1 minute' WHERE id = (SELECT id FROM consultation_bookings WHERE status = 'confirmed' ORDER BY created_at DESC LIMIT 1);"
npm run jobs:consultations
npm run verify:stripe-run
```

You should see the job report one share released, and the check show the transfer OK: the amount is 75% of the price minus the processing fee, it went to the practitioner's connected account, and it is tied to the original payment. In the Stripe Dashboard (test mode), Connect, Transfers, there is a transfer to the practitioner's account.

## Step 9. Send the results back

Send the full output of npm run stripe:check-env and npm run verify:stripe-run, and a screenshot of anything that looked wrong. A FAIL is information: it shows whether the product or the checking script disagrees with Stripe, and either is worth knowing before launch.

## What good looks like

| Step | Where to look | You should see |
|---|---|---|
| 3 | Terminal | No FAIL lines |
| 4 | Practitioner console | Green banner: You are live |
| 5 | Booking page; Terminal B | Confirmed with a join link; the delivery shows 200 |
| 6 | verify:stripe-run | Every line OK for the booking |
| 7 | verify:stripe-run; Stripe Dashboard | Refund amount equals the payment minus the fee |
| 8 | verify:stripe-run; Stripe Dashboard | A transfer of 75% minus the fee to the practitioner's account |

## Practitioners outside the US: a finding to decide on

- As built, a practitioner's Stripe account is created without a country, so Stripe makes a US account. A practitioner in another country, for example India, cannot complete onboarding. For this first run use a US-based test practitioner.
- Stripe supports paying people in other countries from a US platform only as cross-border payouts. Stripe decides whether to enable that for your platform, based on your platform profile.
- The rules differ by country. For India, Stripe describes special restrictions, and its own pages disagree about whether the full or the recipient service agreement applies. Each cross-border payout carries an extra fee (Stripe's documentation says 0.25%), there are minimum amounts per country, and Stripe does not support practitioners directly under the recipient agreement.
- Before promising payouts to practitioners outside the US, ask Stripe support whether cross-border payouts can be enabled for your platform and which service agreement applies. Then we add the country and agreement to account creation and repeat this run with a non-US test account.
- Decision for you: launch with US-based practitioners first?

## Safety and cleanup

- Test mode moves no real money. The local database holds only test data.
- Never reuse this .env file for the live system. Live keys are a separate, later step.
- To tidy up, delete the test connected accounts in the Stripe Dashboard (test mode), and drop the aidh_stripe_test database.
- A live acceptance run, with one small real payment, is a separate step after this one passes.
