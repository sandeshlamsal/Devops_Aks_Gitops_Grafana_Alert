# infrastructure/secrets — secret management (External Secrets Operator + OpenBao)

Keeps secret **values** out of git. The repo holds only *references*; a controller pulls
the real values from an external store and writes native Kubernetes `Secret`s.

- **External Secrets Operator (ESO)** — Apache-2.0, CNCF. Watches `ClusterSecretStore` /
  `ExternalSecret` CRs and syncs.
- **OpenBao** — MPL-2.0, Linux Foundation. The open-source fork of HashiCorp Vault; the
  secret backend. (ESO's `vault` provider talks to it unchanged.)

```
OpenBao  (kv/monitoring/gmail-smtp, kv/monitoring/grafana-admin)
   ▲  Kubernetes auth (ESO's ServiceAccount token → role "external-secrets" → policy)
   │
External Secrets Operator ── reconciles ExternalSecret CRs ──►  Secret monitoring/gmail-smtp-secret
                                                                Secret monitoring/grafana-admin
   │                                                                   │              │
   │                                                     alertmanager-config.yaml   grafana.yaml
   │                                                     (authPassword)             (GF_SECURITY_ADMIN_PASSWORD)
```

## Flux Kustomizations (apply order)

| Kustomization | Path | Depends on |
|---|---|---|
| `external-secrets-operator` | `infrastructure/secrets/operator` | — |
| `openbao` | `infrastructure/secrets/openbao` | — |
| `secrets` | `infrastructure/secrets` (store + ExternalSecrets) | `external-secrets-operator`, `openbao`, `prometheus` |
| `alert`, `grafana` | (unchanged) | now also `dependsOn: secrets` |

## Files

| Path | Purpose |
|---|---|
| `operator/` | ESO Helm install (namespace `external-secrets`) — own Kustomization (has CRDs) |
| `openbao/openbao.yaml` | OpenBao standalone Helm install (namespace `openbao`, file storage on a 1Gi PVC) |
| `stores/clustersecretstore-openbao.yaml` | `ClusterSecretStore/openbao` — how ESO reaches + authenticates to OpenBao |
| `externalsecrets/gmail-smtp.yaml` | `ExternalSecret` → Secret `gmail-smtp-secret` (key `password`) in `monitoring` |
| `externalsecrets/grafana-admin.yaml` | `ExternalSecret` → Secret `grafana-admin` (key `password`) in `monitoring` |

---

## Bootstrap OpenBao (one time, after first install / after any Tier ≥ 2 rebuild)

OpenBao starts **sealed and empty**. Do this once; the unseal keys + root token are the
only things you keep outside the cluster (a password manager, obviously).

```bash
kubectl -n openbao exec -it openbao-0 -- sh
# --- inside the pod ---
export BAO_ADDR=http://127.0.0.1:8200

# 1. initialise (prints 5 unseal keys + a root token — SAVE THESE)
bao operator init -key-shares=5 -key-threshold=3

# 2. unseal (run 3× with 3 different keys)
bao operator unseal <KEY_1>
bao operator unseal <KEY_2>
bao operator unseal <KEY_3>

# 3. log in with the root token
bao login <ROOT_TOKEN>

# 4. enable a KV v2 store at path "kv"
bao secrets enable -path=kv kv-v2

# 5. enable Kubernetes auth so ESO can authenticate with its ServiceAccount token
bao auth enable kubernetes
bao write auth/kubernetes/config \
    kubernetes_host="https://kubernetes.default.svc"

# 6. a policy that can read the monitoring secrets
bao policy write eso-monitoring - <<'EOF'
path "kv/data/monitoring/*" { capabilities = ["read"] }
EOF

# 7. bind ESO's ServiceAccount (external-secrets/external-secrets) to that policy
bao write auth/kubernetes/role/external-secrets \
    bound_service_account_names=external-secrets \
    bound_service_account_namespaces=external-secrets \
    policies=eso-monitoring \
    ttl=1h

# 8. seed the actual secrets
bao kv put kv/monitoring/gmail-smtp    password='YOUR_GMAIL_APP_PASSWORD'
bao kv put kv/monitoring/grafana-admin password='A_STRONG_ADMIN_PASSWORD'
exit
```

Within a minute ESO creates the two Secrets and `alert` / `grafana` proceed.

> **Persistence.** OpenBao's data is on PVC `data-openbao-0`. It survives pod restarts and
> `az aks stop`/`start` (Tier 1), so you only redo steps 2–3 (unseal) after a restart, not
> the whole thing. A full teardown (Tier ≥ 2) loses the PVC → redo all steps.
> For production: `server.ha` + Raft + **auto-unseal** (Azure Key Vault) so no manual
> unseal, and don't keep a long-lived root token.

---

## Verify

```bash
kubectl get pods -n external-secrets            # external-secrets, -webhook, -cert-controller
kubectl get pods -n openbao                     # openbao-0  (READY 1/1 once unsealed)
kubectl get clustersecretstore                  # openbao → STATUS Valid
kubectl get externalsecret -n monitoring        # gmail-smtp-secret, grafana-admin → SecretSynced=True
kubectl get secret -n monitoring gmail-smtp-secret grafana-admin
kubectl describe externalsecret gmail-smtp-secret -n monitoring   # events on failure
```

## Add a new secret

1. `bao kv put kv/monitoring/<name> <field>='<value>'`
2. Add an `ExternalSecret` under `externalsecrets/` (copy `gmail-smtp.yaml`), set
   `remoteRef.key: monitoring/<name>` and `remoteRef.property: <field>`, and
   `target.name` to the Secret name the consumer expects.
3. List it in `kustomization.yaml`.
4. Commit, push, `flux reconcile kustomization nginx-demo-config-secrets -n flux-system`.
