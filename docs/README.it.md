# Tesla Voice MCP — panoramica italiana

**Un server MCP open source per interrogare e, quando espressamente autorizzato, controllare alcune funzionalità Tesla tramite un assistente AI compatibile.**

Il progetto non sostituisce l'app Tesla. Aggiunge un livello **conversazionale e programmabile**: invece di limitarsi a mostrare un dato, un assistente può usare strumenti distinti per leggere lo stato della vettura, contestualizzarlo, stimare energia e costi, cercare possibili colonnine e preparare azioni autorizzate. La voce dipende dal client AI utilizzato; non c'è un motore vocale integrato.

## Perché può essere utile

1. **Contesto in linguaggio naturale.** Si può chiedere lo stato della batteria, se una lettura è aggiornata, quali controlli sono autorizzati e quali informazioni non sono disponibili.
2. **Pianificazione energetica esplicita.** Calcoli di percorrenza e riserva basati su distanza, consumo, capacità batteria e margini dichiarati, senza spacciarli per previsioni ufficiali Tesla.
3. **Ricerca e confronto delle ricariche.** Il sistema interroga fonti pubbliche e distingue DC/HPC per i viaggi e AC per la ricerca locale; può confrontare tariffe fornite dall'utente e leggere, se disponibile, il listino pubblico Free To X con fonte e data.
4. **Comandi con permessi separati.** Letture, posizione e controllo remoto richiedono autorizzazioni diverse. Le operazioni fisiche non devono partire senza richiesta esplicita e i comandi sensibili sono subordinati a Tesla Fleet API e chiave virtuale.
5. **Più controllo sull'installazione.** Ogni utente può ospitare la propria istanza, decidere quali funzioni abilitare, scegliere il fornitore OAuth e conservare privatamente i propri token cifrati.
6. **Codice ispezionabile.** La community può studiare i contratti MCP, la gestione degli errori, i limiti di richiesta e i test, senza dipendere da un servizio centralizzato del manutentore.

## Funzionalità documentate nel codice

| Modulo | Cosa fa | Stato |
| --- | --- | --- |
| Autenticazione | OAuth Tesla separato da OAuth del client MCP; controlli di scope, firma, soggetto e scadenza; gestione token privata | Implementato, configurazione necessaria |
| Batteria e vettura | Letture cached/live, stato connessione, ricarica, clima, serrature/Sentry, software e storico dei campioni raccolti | Implementato, dipendente dai dati Tesla |
| Posizione | GPS su richiesta, indirizzo parlato tramite mappe esterne con consenso, punti di ricarica vicini | Implementato, sensibile e dipendente dai provider |
| Viaggi | Percorsi stradali, stima energia, SOC d'arrivo, riserva minima, soste DC/HPC e preventivi economici | Stime implementate, non garanzie operative |
| Preferenze | Capacità e consumo dichiarati, efficienza, SOC target, riserva, consenso mappe, alias Casa/Lavoro | Persistenza privata, solo su richiesta |
| Comandi Tesla | Catalogo di 75 operazioni codificate, preparazione, esecuzione autorizzata, ricevute e audit del tentativo | Gate di sicurezza, hardware e firmware variabili |
| Navigazione multipoint | Risoluzione nomi, Place ID opzionali e trasporti nativi/GPS sperimentali | **Non verificata come itinerario completo sul display** |

## Esempi concreti

- «Qual è l'ultimo livello di batteria disponibile e a che ora è stato rilevato?»
- «Quanti kWh servirebbero per percorrere 250 km mantenendo il 15% di riserva?»
- «Trovami colonnine DC/HPC lungo il percorso e segnala quelle con disponibilità o prezzo non verificato.»
- «Confronta queste due tariffe, includendo la dispersione di ricarica che ti indico.»
- «Prepara la navigazione verso una destinazione identificata, ma non inviare nulla senza la mia richiesta.»

I risultati dipendono dai tool abilitati, dai permessi della chat e dalla disponibilità della Tesla. **L'accettazione di una richiesta API non equivale a un comando riuscito sulla vettura.**

## Cosa serve a chi lo scarica

Non basta inserire username e password Tesla. Ogni utilizzatore deve creare una **propria** applicazione Fleet API, configurare un server HTTPS con l'endpoint `/mcp`, un sistema OAuth separato per l'assistente AI, un archivio Redis privato e una chiave di cifratura, collegare il proprio account Tesla e verificare i permessi del client. Google Places è opzionale e può richiedere costi aggiuntivi.

ChatGPT e gli altri client non supportano tutti gli stessi strumenti: **la compatibilità dipende dal piano e dal supporto MCP/OAuth del client**. In particolare, la disponibilità di comandi di scrittura in ChatGPT è soggetta ai privilegi e ai piani previsti da OpenAI. Non è un plug-in universalmente installabile con un clic.

## Limiti espliciti e sicurezza

- Nessuna garanzia di percorso multipoint completo sulla schermata dell'auto; evitare invii ripetuti di singole destinazioni come surrogato.
- Nessuna garanzia che una colonnina risulti effettivamente libera, compatibile o tariffata come indicato online; un indirizzo non certifica il preriscaldamento Tesla.
- Nessuna promessa di costi zero, compatibilità con tutti i modelli o esecuzione immediata su qualsiasi chat.
- Nessuna app iPhone standalone o funzione di ascolto vocale integrata in questo repository.
- Il software è indipendente, non ufficiale e non approvato da Tesla o OpenAI.
- Le credenziali, il VIN, le destinazioni private e le chiavi non devono mai entrare in un repository pubblico.

**Documentazione completa in inglese:** [README](../README.md) · [Funzionalità e tool](FEATURES.md) · [Installazione](GETTING_STARTED.md) · [Sicurezza](../SECURITY.md) · [Compatibilità client](CLIENT_COMPATIBILITY.md).
