# AKS GitOps Demo — nginx + kube-prometheus-stack via Flux

Minimal nginx app deployed to AKS via Flux + Kustomize, with Prometheus/Grafana/Alertmanager
installed as a Flux-managed Helm release.

## Structure

```
docker/                          Dockerfile + static site for the nginx image
apps/nginx-demo/base/            Base Deployment + Service (Kustomize)
apps/nginx-demo/overlays/dev/    Dev overlay (replica count patch)
infrastructure/monitoring/       HelmRepository + HelmRelease for kube-prometheus-stack
clusters/dev/                    Flux Kustomization CRDs (what Flux reconciles)
```

## Before you push

1. Image path is already set to `sanaksregistry.azurecr.io/nginx-demo:v1` in
   `apps/nginx-demo/base/deployment.yaml`. Make sure you actually push the
   `nginx-demo:v1` tag to that registry (see "Build and push the image" below)
   before Flux tries to deploy it, or pods will sit in `ImagePullBackOff`.
2. Replace `smtp_auth_password` in `infrastructure/monitoring/helmrelease.yaml`
   with an **App Password** for `parasisandesh@hotmail.com` (the same account is
   used as both sender and recipient). Outlook/Hotmail requires 2-step verification
   to be enabled first, then generate an app password at
   https://account.live.com/proofs/AppPassword — your normal Microsoft account
   password will not work over SMTP.
   **This repo is public — do not commit a real app password in plaintext.**
   Move it into a Kubernetes Secret instead (see note at the bottom of this file).
3. Change `grafana.adminPassword` in the same file to something real, or switch
   to a Secret instead of a plaintext value.

## Build and push the image

```bash
cd docker
docker build -t nginx-demo:v1 .
az acr login --name sanaksregistry
docker tag nginx-demo:v1 sanaksregistry.azurecr.io/nginx-demo:v1
docker push sanaksregistry.azurecr.io/nginx-demo:v1
az aks update --resource-group san-rg --name san-dev-aks --attach-acr sanaksregistry
```

## Enable Flux on AKS and point it at this repo

```bash
az provider register --namespace Microsoft.KubernetesConfiguration

FLUX EXTENSION ADD
az k8s-extension create \
  --resource-group san-rg \
  --cluster-name san-dev-aks \
  --cluster-type managedClusters \
  --name flux \
  --extension-type microsoft.flux

ALERT
az k8s-configuration flux create \
  --resource-group san-rg \
  --cluster-name san-dev-aks \
  --cluster-type managedClusters \
  --name nginx-demo-config \
  --namespace flux-system \
  --url https://github.com/sandeshlamsal/Devops_Aks_Gitops_Grafana_Alert \
  --branch main \
  --kustomization name=apps path=./apps/nginx-demo/overlays/dev prune=true \
  --kustomization name=infrastructure path=./infrastructure/monitoring prune=true
```

## Verify

```bash
kubectl get gitrepository -n flux-system
kubectl get kustomization -n flux-system
kubectl get pods -n default
kubectl get pods -n monitoring
kubectl get svc nginx-demo-svc --watch
```

## Access Grafana

```bash
kubectl port-forward -n monitoring svc/kube-prom-stack-grafana 3000:80
```
Visit http://localhost:3000 (user: `admin`, password: value of `grafana.adminPassword`).

## Test an alert (GitOps-driven)

Edit `apps/nginx-demo/overlays/dev/replica-patch.yaml`, set `replicas: 0`, commit, push.
Flux reconciles within ~5 min, pods disappear, and a `KubePodNotReady`-style alert fires.

```bash
kubectl port-forward -n monitoring svc/kube-prom-stack-alertmanager 9093:9093
```
Visit http://localhost:9093 to see it firing, and check Slack if configured.

Revert by setting `replicas: 2` again, commit, push — never `kubectl edit` directly;
git is the source of truth.

## Securing the SMTP password (recommended before pushing)

Since this repo is public, don't leave `smtp_auth_password` in plaintext in
`helmrelease.yaml`. Instead:

1. Create the secret directly on the cluster (not in git):
   ```bash
   kubectl create secret generic alertmanager-smtp \
     --namespace monitoring \
     --from-literal=password='YOUR_APP_PASSWORD'
   ```
2. Reference it in `helmrelease.yaml` by replacing `smtp_auth_password: "..."` with:
   ```yaml
   smtp_auth_password_file: /etc/alertmanager/secrets/alertmanager-smtp/password
   ```
   and adding under `alertmanager.alertmanagerSpec`:
   ```yaml
   secrets:
     - alertmanager-smtp
   ```
   This mounts the secret into the Alertmanager pod instead of storing it in git.
