// import { EventEmitter } from 'events';
// import { Blockchain, BlockData } from './blockchain';
//
// export class Miner {
//     private blockchain: Blockchain;
//     private isMining: boolean;
//     private eventEmitter: EventEmitter;
//
//     constructor(blockchain: Blockchain, eventEmitter: EventEmitter) {
//         this.blockchain = blockchain;
//         this.isMining = false;
//         this.eventEmitter = eventEmitter;
//
//         // Nasłuchiwanie na zdarzenia
//         this.eventEmitter.on('startMining', this.startMining.bind(this));
//         this.eventEmitter.on('stopMining', this.stopMining.bind(this));
//     }
//
//     private async startMining() {
//         if (this.isMining) {
//             console.log('Kopanie już jest w toku.');
//             return;
//         }
//         this.isMining = true;
//         console.log('Rozpoczynam kopanie...');
//
//         while (this.isMining) {
//             try {
//                 const result = this.blockchain.mine();
//                 if (result) {
//                     const newBlock = this.blockchain.getLastBlock();
//
//                     // Broadcast nowego bloku
//                     const blockToBroadcast: BlockData = { ...newBlock.toDict(), hash: newBlock.hash };
//                     console.log(`Blok #${result} został wykopany i rozesłany.`);
//                     await broadcastBlock(blockToBroadcast);
//
//                     // Kontynuuj kopanie kolejnego bloku
//                     console.log('Kontynuuję kopanie kolejnego bloku...');
//                 } else {
//                     console.log('Brak transakcji do kopania. Oczekuję na nowe transakcje...');
//                     // Czekaj przed kolejną próbą kopania
//                     await new Promise(resolve => setTimeout(resolve, 5000));
//                 }
//             } catch (error: any) {
//                 console.error(`Błąd podczas kopania: ${error.message}`);
//             }
//         }
//     }
//
//     private stopMining() {
//         if (!this.isMining) {
//             console.log('Kopanie nie jest w toku.');
//             return;
//         }
//         this.isMining = false;
//         console.log('Kopanie zostało zatrzymane.');
//     }
// }
