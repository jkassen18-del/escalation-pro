# Single sign-on with Microsoft Entra ID

People sign in with their Microsoft work account. InfraTicket is the SAML 2.0
*service provider*; Entra ID is the *identity provider*. Any other SAML 2.0
provider (Okta, Google Workspace, ADFS) works the same way.

Before you start, set **Settings → App URL** to the address people use to reach
InfraTicket, for example `https://tickets.example.com`. Entra must be able to
send the browser back to it, so it has to be the real address, and it should be
https.

## 1. Create the application in Entra ID

1. Sign in to the [Entra admin centre](https://entra.microsoft.com/) as at least
   a Cloud Application Administrator.
2. Open **Enterprise applications → New application → Create your own
   application**.
3. Name it `InfraTicket`, choose **Integrate any other application you don't
   find in the gallery (Non-gallery)**, and click **Create**.
4. In the new application, open **Single sign-on** and choose **SAML**.

## 2. Tell Entra about InfraTicket

In InfraTicket, open **Settings → Single sign-on (SAML)**. Step 1 there shows
three values with copy buttons.

In Entra, go to **Basic SAML Configuration → Edit** and enter:

| Entra field | Value from InfraTicket |
| --- | --- |
| Identifier (Entity ID) | `https://tickets.example.com/api/auth/saml/metadata` |
| Reply URL (Assertion Consumer Service URL) | `https://tickets.example.com/api/auth/saml/acs` |
| Sign on URL | `https://tickets.example.com/api/auth/saml/login` |

Leave *Relay State* and *Logout URL* empty, then save.

Alternatively, download the service provider metadata from InfraTicket and use
**Upload metadata file** in Entra.

## 3. Tell InfraTicket about Entra

1. In Entra, under **SAML Certificates**, copy the **App Federation Metadata
   Url**.
2. In InfraTicket, paste it into step 2 and click **Import**. This fills in the
   Microsoft Entra Identifier, the login URL and the signing certificate.

If the import cannot reach Entra (for example on a server with no internet
access), fill the three fields in by hand:

- **Microsoft Entra Identifier** and **Login URL**: from section 4 of the
  Entra SAML page (*Set up InfraTicket*).
- **Signing certificate**: download **Certificate (Base64)** and paste the
  file's contents.

The default claims Entra sends (email address, display name) are what
InfraTicket reads, so **Attributes & Claims** needs no change. To map groups
to roles, add a **group claim** there and use **Group ID** as the source
attribute.

## 4. Decide who can sign in

1. In Entra, under **Users and groups**, assign the people or groups who should
   use InfraTicket. With the default *Assignment required = Yes*, nobody else
   can sign in.
2. In InfraTicket, choose one of these:
   - **Leave "Create accounts on first sign-in" off.** Only people who already
     have an account here, matched by email, can sign in. This is the safest
     choice.
   - **Turn it on.** Anyone Entra lets through gets an account with the role
     and team you choose.
3. Optionally, under **Roles from groups**, map Entra group object IDs to
   roles. The mapping is applied at every sign-in, and the highest match wins.
   It never changes an administrator.

## 5. Turn it on

1. Tick **Offer single sign-on on the sign-in page** and save. The sign-in page
   now shows **Sign in with Microsoft**.
2. Try it in a private browser window before going further.
3. When it works, you can tick **Require single sign-on for everyone except
   administrators**. Password sign-in is then refused for everyone else.
   Administrators keep their passwords, so a misconfigured or unavailable
   identity provider can never lock everyone out.

## Certificate rollover

Entra certificates expire, after three years by default.

1. In Entra, create the new certificate but do not make it active yet.
2. In InfraTicket, paste the new certificate under the current one in the
   signing certificate box, separated by a blank line, and save. Both are now
   trusted.
3. In Entra, make the new certificate active.
4. In InfraTicket, remove the old certificate and save.

## When sign-in fails

The sign-in page shows the reason, and the audit log records every failure
(action `sso_login_failed`). The server log has the technical detail
(`[sso] rejected response: …`).

| You see | Usually |
| --- | --- |
| "could not be verified" | The certificate in InfraTicket is not the one Entra signs with, the Identifier does not match exactly, or the server clock is more than two minutes out |
| "has no account here" | Create the person under People, or turn on *Create accounts on first sign-in* |
| Entra error AADSTS50011 | The Reply URL in Entra does not match the App URL in InfraTicket |
| Entra error AADSTS700016 | The Identifier in Entra does not match |
