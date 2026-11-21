# Recover an existing administrator from the host

Use this only when an authorized ReadyPackets administrator cannot recover through the portal. This host-only command never creates or reactivates an account. It revokes the named active administrator’s sessions, retires outstanding password links, clears all local factors and pending factor ceremonies, and issues a generated temporary local password. The Entra link is not changed. Use a private interactive terminal that is not being recorded, shared, or redirected. Do not paste the generated password into a ticket, chat, or log.

## Native installation

On the trusted host, run against the active release with the service account and its managed credentials. The transient systemd unit uses a PTY, not journal-backed stdout.

```bash
recover_readypackets_admin() {
  local credential
  local -a credentials=()
  for credential in database_url rp_data_keyring rp_index_key rp_pseudonym_key rp_token_hash_key rp_audit_chain_key; do
    credentials+=("--property=LoadCredential=$credential:/etc/readypackets/secrets/$credential")
  done
  sudo systemd-run --wait --collect --quiet --pty --service-type=exec --expand-environment=no \
    --property=User=readypackets --property=Group=readypackets --property=UMask=0077 \
    --property=NoNewPrivileges=yes --property=ProtectSystem=strict --property=ProtectHome=yes \
    --property=PrivateTmp=yes --property=PrivateDevices=yes --property=CapabilityBoundingSet= \
    --property=LimitCORE=0 --property=ReadWritePaths=/var/lib/readypackets/storage \
    --property=EnvironmentFile=/etc/readypackets/portal.env \
    --property=EnvironmentFile=/opt/readypackets/current/release.env \
    "${credentials[@]}" --working-directory=/opt/readypackets/current --setenv=RP_ROLE=web \
    /bin/bash -c '
      export DATABASE_URL_FILE="$CREDENTIALS_DIRECTORY/database_url"
      export RP_DATA_KEYRING_FILE="$CREDENTIALS_DIRECTORY/rp_data_keyring"
      export RP_INDEX_KEY_FILE="$CREDENTIALS_DIRECTORY/rp_index_key"
      export RP_PSEUDONYM_KEY_FILE="$CREDENTIALS_DIRECTORY/rp_pseudonym_key"
      export RP_TOKEN_HASH_KEY_FILE="$CREDENTIALS_DIRECTORY/rp_token_hash_key"
      export RP_AUDIT_CHAIN_KEY_FILE="$CREDENTIALS_DIRECTORY/rp_audit_chain_key"
      exec /usr/local/bin/node dist/ops/recover-admin.js --email "$1"
    ' bash "$1"
}
recover_readypackets_admin admin@example.com
```

## Docker Compose

Run from the checkout that was used to start the Docker stack. The database must already be running. The wrapper starts a one-off container on the private database network using the service’s mounted credentials and the `none` Docker logging driver. Do not substitute the normal `ops` container, which keeps container logs.

```bash
./deploy/docker/rp-docker.sh recover-admin --email admin@example.com
```

## Complete recovery

Retype the email shown at the prompt. After the command commits, it displays the temporary password once. Sign in via the local sign-in form on the canonical HTTPS portal, enroll a new authenticator app, store the newly issued recovery codes offline, and replace the temporary password. Old factors and codes no longer work. After verifying access, register a passkey and ensure another active administrator has working local MFA.

Check the audit center for the correlated `auth.admin.host_recovery` event at `FATAL` severity, identifying the system actor as `host-operator` and the target by its public ID. The password and email are not audit attributes. If the terminal disconnects after commit and you do not have the issued password, use a new authorized recovery run rather than trying to retrieve the old one.
