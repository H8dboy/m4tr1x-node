# M4TR1X su Oracle Cloud (Always Free)

Oracle regala per sempre (tier *Always Free*, nessun costo a fine trial):

- **1 VM ARM Ampere A1** fino a **4 OCPU + 24 GB RAM** (divisibile in più VM)
- 2 VM AMD micro (1/8 OCPU, 1 GB RAM — strette ma usabili per un nodo leggero)
- 200 GB di storage a blocchi totali
- 10 TB/mese di traffico in uscita

La A1 da 4 core/24 GB è un signor server per un nodo M4TR1X pubblico.

---

## 1. Creazione account (≈10 minuti, serve a te)

1. Vai su **signup.oraclecloud.com**
2. Email + dati anagrafici reali (li verificano)
3. **Home Region: scegli con cura — non si cambia mai più.**
   Consiglio: `EU-Frankfurt-1` o `EU-Milan-1`. Nota: le ARM A1 free sono
   molto richieste; se al momento della creazione VM la regione è satura,
   riprova in orari diversi (notte/mattina presto funziona spesso).
4. Verifica SMS + carta di credito (solo verifica: addebito 0 €, il tier
   Always Free non scala mai a pagamento da solo — al limite i servizi
   si fermano)
5. Account pronto in qualche minuto.

## 2. Crea la VM nodo

Console OCI → **Compute → Instances → Create instance**:

| Campo | Valore |
|-------|--------|
| Image | **Ubuntu 22.04** (o 24.04) |
| Shape | **VM.Standard.A1.Flex** — 2 OCPU / 12 GB bastano (lasciane per una seconda VM) |
| VNIC | subnet pubblica, **Assign public IPv4: sì** |
| SSH key | incolla la tua chiave pubblica |
| **Advanced options → Cloud-init** | incolla il contenuto di [`scripts/cloud-init-oracle.yml`](../scripts/cloud-init-oracle.yml) |

Al primo boot la VM si configura da sola: nodo M4TR1X su `:8080`,
head server su `:8081`, relay Nostr su `:4848`, tutto in systemd con
riavvio automatico.

## 3. Apri le porte nella Security List (passaggio che tutti dimenticano)

Oracle blocca il traffico due volte: in iptables dentro la VM (lo apre il
cloud-init) **e** nella rete virtuale. Per la seconda:

**Networking → Virtual Cloud Networks → (la tua VCN) → Security Lists →
Default Security List → Add Ingress Rules:**

| Source CIDR | Protocollo | Porta | Per cosa |
|-------------|-----------|-------|----------|
| 0.0.0.0/0 | TCP | 8080 | API nodo |
| 0.0.0.0/0 | TCP | 8081 | head server + dashboard |
| 0.0.0.0/0 | TCP | 4848 | relay Nostr (mesh) |

## 4. Verifica

```bash
curl http://<IP-pubblico>:8080/health            # → {"status":"online",...}
curl http://<IP-pubblico>:8081/api/v1/head/ping  # → {"ok":true}
curl http://<IP-pubblico>:8080/api/v1/mesh/status
```

Dashboard head: `http://<IP-pubblico>:8081/`

## 5. Collega il resto della rete

Sui nodi di casa (e nel client Electron), nel `.env`:

```env
HEAD_NODE_URL=http://<IP-pubblico>:8081
```

Da quel momento: i nodi si registrano sul head Oracle, la **relay mesh si
auto-assembla** (ogni nodo scopre i relay degli altri dal head e si
sincronizza), e l'app mobile può connettersi a `http://<IP-pubblico>:8080`
da qualsiasi rete — il primo punto d'ingresso pubblico di M4TR1X.

---

## Nota di filosofia (Nderja)

Oracle è un datacenter centralizzato: comodo per il bootstrap — un punto
d'ingresso sempre acceso con IP pubblico gratis — ma **non deve diventare
la spina dorsale della rete**. La rete vera sono i nodi self-hosted; il
nodo Oracle è un'antenna in più, sacrificabile in ogni momento. Se Oracle
lo spegne domani, la mesh sopravvive: nessun dato esiste solo lì.
