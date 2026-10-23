/**
 * Run by invites-engines.test.ts in a child process, one per database engine.
 * Prints RESULT:<json> for the parent to check.
 */
const { initDatabase, db } = await import('../server/db/index.ts');
const invites = await import('../server/repositories/invites.ts');
const users = await import('../server/repositories/users.ts');
const teams = await import('../server/repositories/teams.ts');

await initDatabase();
const result: Record<string, unknown> = {};
const stamp = Date.now();

const owner = await users.createUser({ email: `owner-${stamp}@inv.test`, username: `owner${stamp}`, name: 'Owner', password: 'x'.repeat(12), role: 'admin' });
const teamId = await teams.createTeam({ key: `I${String(stamp).slice(-6)}`, name: `Invites ${stamp}` });

// Five people racing for a two-use link: exactly two get a use.
const { invite, token } = await invites.createInvite({
  label: 'race',
  roleId: 'role-agent',
  email: null,
  allowedDomains: ['inv.test'],
  teamIds: [teamId],
  maxUses: 2,
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  createdBy: owner,
});
const claims = await Promise.all([1, 2, 3, 4, 5].map(() => invites.claimInviteUse(invite.id)));
result.claimed = claims.filter(Boolean).length;
result.status = (await invites.getInvite(invite.id))?.status;
result.found = (await invites.findInviteByToken(token))?.id === invite.id;
result.allowedDomains = (await invites.getInvite(invite.id))?.allowedDomains;

// Giving one back reopens the link for one more.
await invites.releaseInviteUse(invite.id, claims.find(Boolean)!);
result.afterRelease = (await invites.getInvite(invite.id))?.status;
result.reclaimed = Boolean(await invites.claimInviteUse(invite.id));
result.listed = (await invites.listInvites()).some((item) => item.id === invite.id && item.roleName === 'Agent');

// Department managers survive membership edits.
const member = await users.createUser({ email: `member-${stamp}@inv.test`, username: `member${stamp}`, name: 'Member', password: 'x'.repeat(12), role: 'agent', teamIds: [teamId] });
await users.setDepartmentRole(member, teamId, 'manager');
await users.setUserTeams(member, [teamId]);
result.stillManager = (await users.findUserById(member))?.managedTeamIds;
result.teamManagers = (await teams.findTeamById(teamId))?.managerIds.includes(member);
result.teamId = teamId;

await db.run(`DELETE FROM invites WHERE id = ?`, [invite.id]);
console.log(`RESULT:${JSON.stringify(result)}`);
await db.close?.();
process.exit(0);
