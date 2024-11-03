Co zostało zrobione:

    Dodawanie Transakcji: Umożliwia dodawanie nowych transakcji do blockchaina.
    Kopanie Bloków: Proces znajdowania nowego bloku poprzez algorytm Proof of Work.
    Broadcasting Bloków i Transakcji: Nowo wykopane bloki oraz nowe transakcje są broadcastowane do wszystkich peerów w sieci.
    Rejestracja Węzłów: Możliwość rejestracji nowych węzłów w sieci.
    Obsługa rebroadcastowania: Węzły nie tworzą nieskończonej pętli broadcastowania.

Co Można Jeszcze Zrobić

    Implementacja uwierzytelniania węzłów.
    Poprawa mechanizmu rozwiązywania konfliktów w sieci - ten co teraz jest być może zbyt skomplikowany i lepiej np. wziąć dłuższy łańcuch, a jak są tak samo długie, to ten co ma krótszy hash.
    Broadcast działa, ale nie przerywa kopania innych node'ów, co skutkuje, że każdy kopie swoje bloki.
    Obsługa większej liczby node'ów w sieci.
    Przetestowanie czy na pewno wszystko działa poprawnie.

Wymagania

    Node.js: Wersja 14.x lub nowsza.
    npm: Zarządzanie pakietami.
    TypeScript: Kompilator TypeScript.
    Git: Do klonowania repozytorium (opcjonalnie).

Instalacja

    git clone https://github.com/twoje-repozytorium/blockchain-projekt.git
    cd blockchain-projekt

Instalacja Zależności:

    npm install

Kompilacja TypeScript do JavaScript:

    npm run build
    Odpalacie 4 różne terminale, w których piszecie komendy:
        - npm run start-node1
        - npm run start-node2
        - npm run start-miner1
        - npm run start-miner2
    Najpierw trzeba zarejestrować węzły by móc kopać. W pliku http macie requesty, które możecie stosować do dodawania nowych transakcji itp.


Opis Skryptów

    start-node1: Uruchamia pierwszy węzeł na porcie 5000.
    start-node2: Uruchamia drugi węzeł na porcie 5001.
    start-miner1: Uruchamia pierwszego miner'a, który łączy się z węzłami na portach 5000 i 5001.
    start-miner2: Uruchamia drugiego miner'a, który łączy się z węzłami na portach 5001 i 5000.
    start: Uruchamia węzeł bez określonego portu (domyślnie 5000).
    miner: Uruchamia miner'a bez określonych peerów (niezalecane).
    dev-node1 / dev-node2: Uruchamia węzły w trybie deweloperskim na odpowiednich portach.
    dev-miner1 / dev-miner2: Uruchamia minerów w trybie deweloperskim, łącząc się z odpowiednimi węzłami.
    dev: Uruchamia węzeł w trybie deweloperskim.
