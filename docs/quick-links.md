# Team links and Quick links

**Quick links** gathers the consoles each department works in (AWS, Azure, Entra ID, an internal dashboard) on one page, so nobody has to hunt for the right portal during an incident.

[Open Quick links](/links)

## Who sees what

- Everyone sees the links of the departments they belong to.
- People with `teams.manage` see every department's links.
- A person in no department sees an empty page.

## Adding links

Links belong to a department. *Manage → Teams → (department) → Links to other systems*:

1. Click a preset, or add a blank link. Presets:
   - **AWS access portal**: `https://<your-directory>.awsapps.com/start`
   - **Azure portal**: `https://portal.azure.com/#@<tenant>`
   - **Entra admin centre**: `https://entra.microsoft.com/`
   - **My Apps**: `https://myapps.microsoft.com/`
2. Fill in **Name**, **Kind** (AWS, Azure, Entra or generic, which sets the icon), **Address** and **Description**.
3. Replace any `<placeholder>` in the address with your own value. The server refuses an address that still contains `<` or `>`.
4. Save.

Addresses must start with `https://`. A `javascript:` or `data:` link is refused, so a link cannot run code inside InfraTicket.

> **Tip** Pair links with single sign-on: with Entra ID in front of both InfraTicket and the consoles, a click goes straight in.
