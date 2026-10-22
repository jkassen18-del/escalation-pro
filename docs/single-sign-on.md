# Single sign-on (Microsoft Entra ID)

People sign in with their Microsoft work account. InfraTicket is the SAML 2.0 *service provider*; Entra ID is the *identity provider*. Okta, Google Workspace, ADFS and any other SAML 2.0 provider work the same way: choose **Another SAML 2.0 provider** under **Identity provider**.

Steps verified against Microsoft's documentation; untested against a live tenant.

[Open Settings](/settings)

## Before you start

Set **Settings → Public URL** to the address people use, for example `https://tickets.example.com`, and save. Entra sends the browser back to it, so it must be the real address and should be https.

> **Note** The SSO section and older guides call this field the *App URL*. It is the **Public URL** field at the top of Settings. When it is empty, the values in step 1 are built from the address in your browser.

## 1. Create the application in Entra ID

1. Sign in to the [Entra admin centre](https://entra.microsoft.com/) as at least a Cloud Application Administrator.
2. **Enterprise applications → New application → Create your own application**.
3. Name it `InfraTicket`, choose **Integrate any other application you don't find in the gallery (Non-gallery)**, and click **Create**.
4. In the new application open **Single sign-on** and choose **SAML**.

## 2. Tell Entra about InfraTicket

In InfraTicket open **Settings → Single sign-on (SAML)**. Step 1 shows the values with copy buttons. In Entra, **Basic SAML Configuration → Edit**:

| Entra field | Value |
| --- | --- |
| Identifier (Entity ID) | `https://tickets.example.com/api/auth/saml/metadata` |
| Reply URL (Assertion Consumer Service URL) | `https://tickets.example.com/api/auth/saml/acs` |
| Sign on URL | `https://tickets.example.com/api/auth/saml/login` |

Leave *Relay State* and *Logout URL* empty and save. Alternatively, click **Download service provider metadata** in InfraTicket and use **Upload metadata file** in Entra.

## 3. Tell InfraTicket about Entra

1. In Entra, under **SAML Certificates**, copy the **App Federation Metadata Url**.
2. In InfraTicket, paste it into **App Federation Metadata URL** and click **Import**. This fills in **Microsoft Entra Identifier**, **Login URL** and **Signing certificate**.

If the server cannot reach the internet, fill the three fields in by hand: the identifier and login URL from section 4 of Entra's SAML page (*Set up InfraTicket*), and the certificate by downloading **Certificate (Base64)** and pasting the file's contents.

The default claims (email address, display name) are what InfraTicket reads, so **Attributes & Claims** needs no change. The **Claim names** section in InfraTicket lets you point **Email**, **Display name** and **Groups** at other claims if your provider differs.

## 4. Decide who can sign in

1. In Entra, under **Users and groups**, assign the people or groups who should use InfraTicket. With *Assignment required = Yes* (the default), nobody else can sign in.
2. In InfraTicket, **Create accounts on first sign-in**:
   - **Off** (safest): only people who already have an account here, matched by email, can sign in.
   - **On**: anyone Entra lets through gets an account with the **Role for new accounts** and **Team for new accounts** you choose.
3. Optionally, under **Roles from groups**, map Entra group object IDs to roles. Add a group claim in Entra first (**Attributes & Claims → Add a group claim**, source attribute **Group ID**). The mapping is applied at every sign-in, the highest matching role wins, and it never changes an administrator.

## 5. Turn it on

1. Tick **Offer single sign-on on the sign-in page** and save. The sign-in page shows **Sign in with Microsoft** (change it with **Button text**).
2. Try it in a private browser window.
3. When it works, you can tick **Require single sign-on for everyone except administrators**. Password sign-in is then refused for everyone else. Administrators keep their passwords, so a broken identity provider can never lock everyone out.

## How it is protected

- The assertion itself must be signed by the configured certificate.
- It must be addressed to this app's entity ID and answer a sign-in request this app issued within the last 10 minutes. **IdP-initiated sign-in (from My Apps) is not supported**; the *Sign on URL* starts a fresh request instead, so a My Apps tile still works if you set it.
- Each assertion is accepted once. Clock skew up to 2 minutes is tolerated.
- The return path must be a path on this site, so it cannot become an open redirect.
- Accounts created by SSO get an unusable random password.

## Certificate rollover

Entra certificates expire after three years by default.

1. In Entra, create the new certificate but do not activate it.
2. In InfraTicket, paste the new certificate under the current one in **Signing certificate**, separated by a blank line, and save. Both are trusted.
3. In Entra, make the new certificate active.
4. In InfraTicket, remove the old one and save.

## When sign-in fails

The sign-in page shows the reason, the audit log records it (`sso_login_failed`), and the server log has the detail (`[sso] rejected response: …`).

| You see | Usually |
| --- | --- |
| "could not be verified" | Wrong certificate, the Identifier does not match exactly, or the server clock is more than two minutes out |
| "has no account here" | Create the person under People, or turn on *Create accounts on first sign-in* |
| Entra error AADSTS50011 | The Reply URL in Entra does not match the Public URL |
| Entra error AADSTS700016 | The Identifier in Entra does not match |
