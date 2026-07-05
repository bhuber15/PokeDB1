import './load-env'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import * as schema from '../lib/db/schema'
import { parsePounds } from '../lib/pricing'

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
})
const db = drizzle(client, { schema })

const MOCK_CARDS = [
  // Base Set
  { name: 'Charizard', setName: 'Base Set', setNumber: '4/102', variant: 'Holo Rare', externalId: 'base1-4', imageUrl: 'https://images.pokemontcg.io/base1/4.png', imageUrlLarge: 'https://images.pokemontcg.io/base1/4_hires.png', market: 420.00, cost: 280.00 },
  { name: 'Blastoise', setName: 'Base Set', setNumber: '2/102', variant: 'Holo Rare', externalId: 'base1-2', imageUrl: 'https://images.pokemontcg.io/base1/2.png', imageUrlLarge: 'https://images.pokemontcg.io/base1/2_hires.png', market: 120.00, cost: 75.00 },
  { name: 'Venusaur', setName: 'Base Set', setNumber: '15/102', variant: 'Holo Rare', externalId: 'base1-15', imageUrl: 'https://images.pokemontcg.io/base1/15.png', imageUrlLarge: 'https://images.pokemontcg.io/base1/15_hires.png', market: 95.00, cost: 60.00 },
  { name: 'Pikachu', setName: 'Base Set', setNumber: '58/102', variant: null, externalId: 'base1-58', imageUrl: 'https://images.pokemontcg.io/base1/58.png', imageUrlLarge: 'https://images.pokemontcg.io/base1/58_hires.png', market: 18.00, cost: 10.00 },
  { name: 'Mewtwo', setName: 'Base Set', setNumber: '10/102', variant: 'Holo Rare', externalId: 'base1-10', imageUrl: 'https://images.pokemontcg.io/base1/10.png', imageUrlLarge: 'https://images.pokemontcg.io/base1/10_hires.png', market: 85.00, cost: 55.00 },
  { name: 'Gyarados', setName: 'Base Set', setNumber: '6/102', variant: 'Holo Rare', externalId: 'base1-6', imageUrl: 'https://images.pokemontcg.io/base1/6.png', imageUrlLarge: 'https://images.pokemontcg.io/base1/6_hires.png', market: 65.00, cost: 40.00 },
  { name: 'Chansey', setName: 'Base Set', setNumber: '3/102', variant: 'Holo Rare', externalId: 'base1-3', imageUrl: 'https://images.pokemontcg.io/base1/3.png', imageUrlLarge: 'https://images.pokemontcg.io/base1/3_hires.png', market: 55.00, cost: 35.00 },
  { name: 'Alakazam', setName: 'Base Set', setNumber: '1/102', variant: 'Holo Rare', externalId: 'base1-1', imageUrl: 'https://images.pokemontcg.io/base1/1.png', imageUrlLarge: 'https://images.pokemontcg.io/base1/1_hires.png', market: 45.00, cost: 28.00 },
  { name: 'Machamp', setName: 'Base Set', setNumber: '8/102', variant: 'Holo Rare', externalId: 'base1-8', imageUrl: 'https://images.pokemontcg.io/base1/8.png', imageUrlLarge: 'https://images.pokemontcg.io/base1/8_hires.png', market: 22.00, cost: 12.00 },
  { name: 'Raichu', setName: 'Base Set', setNumber: '14/102', variant: 'Holo Rare', externalId: 'base1-14', imageUrl: 'https://images.pokemontcg.io/base1/14.png', imageUrlLarge: 'https://images.pokemontcg.io/base1/14_hires.png', market: 40.00, cost: 25.00 },

  // Jungle
  { name: 'Scyther', setName: 'Jungle', setNumber: '10/64', variant: 'Holo Rare', externalId: 'jungle-10', imageUrl: 'https://images.pokemontcg.io/jungle/10.png', imageUrlLarge: 'https://images.pokemontcg.io/jungle/10_hires.png', market: 28.00, cost: 16.00 },
  { name: 'Pinsir', setName: 'Jungle', setNumber: '9/64', variant: 'Holo Rare', externalId: 'jungle-9', imageUrl: 'https://images.pokemontcg.io/jungle/9.png', imageUrlLarge: 'https://images.pokemontcg.io/jungle/9_hires.png', market: 18.00, cost: 10.00 },
  { name: 'Jolteon', setName: 'Jungle', setNumber: '4/64', variant: 'Holo Rare', externalId: 'jungle-4', imageUrl: 'https://images.pokemontcg.io/jungle/4.png', imageUrlLarge: 'https://images.pokemontcg.io/jungle/4_hires.png', market: 35.00, cost: 20.00 },
  { name: 'Flareon', setName: 'Jungle', setNumber: '3/64', variant: 'Holo Rare', externalId: 'jungle-3', imageUrl: 'https://images.pokemontcg.io/jungle/3.png', imageUrlLarge: 'https://images.pokemontcg.io/jungle/3_hires.png', market: 30.00, cost: 18.00 },
  { name: 'Vaporeon', setName: 'Jungle', setNumber: '12/64', variant: 'Holo Rare', externalId: 'jungle-12', imageUrl: 'https://images.pokemontcg.io/jungle/12.png', imageUrlLarge: 'https://images.pokemontcg.io/jungle/12_hires.png', market: 32.00, cost: 19.00 },

  // Fossil
  { name: 'Gengar', setName: 'Fossil', setNumber: '5/62', variant: 'Holo Rare', externalId: 'fossil-5', imageUrl: 'https://images.pokemontcg.io/fossil/5.png', imageUrlLarge: 'https://images.pokemontcg.io/fossil/5_hires.png', market: 55.00, cost: 34.00 },
  { name: 'Lapras', setName: 'Fossil', setNumber: '10/62', variant: 'Holo Rare', externalId: 'fossil-10', imageUrl: 'https://images.pokemontcg.io/fossil/10.png', imageUrlLarge: 'https://images.pokemontcg.io/fossil/10_hires.png', market: 38.00, cost: 22.00 },
  { name: 'Articuno', setName: 'Fossil', setNumber: '2/62', variant: 'Holo Rare', externalId: 'fossil-2', imageUrl: 'https://images.pokemontcg.io/fossil/2.png', imageUrlLarge: 'https://images.pokemontcg.io/fossil/2_hires.png', market: 42.00, cost: 26.00 },
  { name: 'Zapdos', setName: 'Fossil', setNumber: '15/62', variant: 'Holo Rare', externalId: 'fossil-15', imageUrl: 'https://images.pokemontcg.io/fossil/15.png', imageUrlLarge: 'https://images.pokemontcg.io/fossil/15_hires.png', market: 40.00, cost: 24.00 },
  { name: 'Moltres', setName: 'Fossil', setNumber: '12/62', variant: 'Holo Rare', externalId: 'fossil-12', imageUrl: 'https://images.pokemontcg.io/fossil/12.png', imageUrlLarge: 'https://images.pokemontcg.io/fossil/12_hires.png', market: 38.00, cost: 22.00 },

  // Neo Genesis
  { name: 'Lugia', setName: 'Neo Genesis', setNumber: '9/111', variant: 'Holo Rare', externalId: 'neo1-9', imageUrl: 'https://images.pokemontcg.io/neo1/9.png', imageUrlLarge: 'https://images.pokemontcg.io/neo1/9_hires.png', market: 220.00, cost: 140.00 },
  { name: 'Typhlosion', setName: 'Neo Genesis', setNumber: '17/111', variant: 'Holo Rare', externalId: 'neo1-17', imageUrl: 'https://images.pokemontcg.io/neo1/17.png', imageUrlLarge: 'https://images.pokemontcg.io/neo1/17_hires.png', market: 45.00, cost: 28.00 },
  { name: 'Feraligatr', setName: 'Neo Genesis', setNumber: '5/111', variant: 'Holo Rare', externalId: 'neo1-5', imageUrl: 'https://images.pokemontcg.io/neo1/5.png', imageUrlLarge: 'https://images.pokemontcg.io/neo1/5_hires.png', market: 48.00, cost: 30.00 },
  { name: 'Meganium', setName: 'Neo Genesis', setNumber: '10/111', variant: 'Holo Rare', externalId: 'neo1-10', imageUrl: 'https://images.pokemontcg.io/neo1/10.png', imageUrlLarge: 'https://images.pokemontcg.io/neo1/10_hires.png', market: 42.00, cost: 26.00 },
  { name: 'Pichu', setName: 'Neo Genesis', setNumber: '12/111', variant: null, externalId: 'neo1-12', imageUrl: 'https://images.pokemontcg.io/neo1/12.png', imageUrlLarge: 'https://images.pokemontcg.io/neo1/12_hires.png', market: 12.00, cost: 7.00 },

  // Neo Revelation
  { name: 'Ho-Oh', setName: 'Neo Revelation', setNumber: '7/64', variant: 'Holo Rare', externalId: 'neo3-7', imageUrl: 'https://images.pokemontcg.io/neo3/7.png', imageUrlLarge: 'https://images.pokemontcg.io/neo3/7_hires.png', market: 185.00, cost: 120.00 },
  { name: 'Entei', setName: 'Neo Revelation', setNumber: '6/64', variant: 'Holo Rare', externalId: 'neo3-6', imageUrl: 'https://images.pokemontcg.io/neo3/6.png', imageUrlLarge: 'https://images.pokemontcg.io/neo3/6_hires.png', market: 55.00, cost: 34.00 },
  { name: 'Suicune', setName: 'Neo Revelation', setNumber: '14/64', variant: 'Holo Rare', externalId: 'neo3-14', imageUrl: 'https://images.pokemontcg.io/neo3/14.png', imageUrlLarge: 'https://images.pokemontcg.io/neo3/14_hires.png', market: 60.00, cost: 38.00 },
  { name: 'Raikou', setName: 'Neo Revelation', setNumber: '10/64', variant: 'Holo Rare', externalId: 'neo3-10', imageUrl: 'https://images.pokemontcg.io/neo3/10.png', imageUrlLarge: 'https://images.pokemontcg.io/neo3/10_hires.png', market: 52.00, cost: 32.00 },

  // EX Ruby & Sapphire
  { name: 'Blaziken', setName: 'EX Ruby & Sapphire', setNumber: '3/109', variant: 'Holo Rare', externalId: 'ex1-3', imageUrl: 'https://images.pokemontcg.io/ex1/3.png', imageUrlLarge: 'https://images.pokemontcg.io/ex1/3_hires.png', market: 22.00, cost: 13.00 },
  { name: 'Swampert', setName: 'EX Ruby & Sapphire', setNumber: '16/109', variant: 'Holo Rare', externalId: 'ex1-16', imageUrl: 'https://images.pokemontcg.io/ex1/16.png', imageUrlLarge: 'https://images.pokemontcg.io/ex1/16_hires.png', market: 20.00, cost: 12.00 },
  { name: 'Sceptile', setName: 'EX Ruby & Sapphire', setNumber: '11/109', variant: 'Holo Rare', externalId: 'ex1-11', imageUrl: 'https://images.pokemontcg.io/ex1/11.png', imageUrlLarge: 'https://images.pokemontcg.io/ex1/11_hires.png', market: 18.00, cost: 11.00 },

  // Diamond & Pearl
  { name: 'Dialga', setName: 'Diamond & Pearl', setNumber: '1/130', variant: 'Holo Rare', externalId: 'dp1-1', imageUrl: 'https://images.pokemontcg.io/dp1/1.png', imageUrlLarge: 'https://images.pokemontcg.io/dp1/1_hires.png', market: 28.00, cost: 17.00 },
  { name: 'Palkia', setName: 'Diamond & Pearl', setNumber: '11/130', variant: 'Holo Rare', externalId: 'dp1-11', imageUrl: 'https://images.pokemontcg.io/dp1/11.png', imageUrlLarge: 'https://images.pokemontcg.io/dp1/11_hires.png', market: 25.00, cost: 15.00 },
  { name: 'Infernape', setName: 'Diamond & Pearl', setNumber: '5/130', variant: 'Holo Rare', externalId: 'dp1-5', imageUrl: 'https://images.pokemontcg.io/dp1/5.png', imageUrlLarge: 'https://images.pokemontcg.io/dp1/5_hires.png', market: 18.00, cost: 10.00 },
  { name: 'Empoleon', setName: 'Diamond & Pearl', setNumber: '4/130', variant: 'Holo Rare', externalId: 'dp1-4', imageUrl: 'https://images.pokemontcg.io/dp1/4.png', imageUrlLarge: 'https://images.pokemontcg.io/dp1/4_hires.png', market: 16.00, cost: 9.00 },
  { name: 'Torterra', setName: 'Diamond & Pearl', setNumber: '17/130', variant: 'Holo Rare', externalId: 'dp1-17', imageUrl: 'https://images.pokemontcg.io/dp1/17.png', imageUrlLarge: 'https://images.pokemontcg.io/dp1/17_hires.png', market: 14.00, cost: 8.00 },

  // Platinum
  { name: 'Giratina', setName: 'Platinum', setNumber: '6/127', variant: 'Holo Rare', externalId: 'pl1-6', imageUrl: 'https://images.pokemontcg.io/pl1/6.png', imageUrlLarge: 'https://images.pokemontcg.io/pl1/6_hires.png', market: 32.00, cost: 20.00 },
  { name: 'Shaymin', setName: 'Platinum', setNumber: '11/127', variant: 'Holo Rare', externalId: 'pl1-11', imageUrl: 'https://images.pokemontcg.io/pl1/11.png', imageUrlLarge: 'https://images.pokemontcg.io/pl1/11_hires.png', market: 22.00, cost: 13.00 },

  // HeartGold SoulSilver
  { name: 'Typhlosion Prime', setName: 'HeartGold SoulSilver', setNumber: '110/123', variant: 'Prime', externalId: 'hgss1-110', imageUrl: 'https://images.pokemontcg.io/hgss1/110.png', imageUrlLarge: 'https://images.pokemontcg.io/hgss1/110_hires.png', market: 38.00, cost: 23.00 },
  { name: 'Feraligatr Prime', setName: 'HeartGold SoulSilver', setNumber: '103/123', variant: 'Prime', externalId: 'hgss1-103', imageUrl: 'https://images.pokemontcg.io/hgss1/103.png', imageUrlLarge: 'https://images.pokemontcg.io/hgss1/103_hires.png', market: 42.00, cost: 26.00 },
  { name: 'Meganium Prime', setName: 'HeartGold SoulSilver', setNumber: '108/123', variant: 'Prime', externalId: 'hgss1-108', imageUrl: 'https://images.pokemontcg.io/hgss1/108.png', imageUrlLarge: 'https://images.pokemontcg.io/hgss1/108_hires.png', market: 35.00, cost: 21.00 },

  // Black & White
  { name: 'Reshiram', setName: 'Black & White', setNumber: '26/114', variant: 'Holo Rare', externalId: 'bw1-26', imageUrl: 'https://images.pokemontcg.io/bw1/26.png', imageUrlLarge: 'https://images.pokemontcg.io/bw1/26_hires.png', market: 18.00, cost: 10.00 },
  { name: 'Zekrom', setName: 'Black & White', setNumber: '47/114', variant: 'Holo Rare', externalId: 'bw1-47', imageUrl: 'https://images.pokemontcg.io/bw1/47.png', imageUrlLarge: 'https://images.pokemontcg.io/bw1/47_hires.png', market: 18.00, cost: 10.00 },
  { name: 'Serperior', setName: 'Black & White', setNumber: '6/114', variant: 'Holo Rare', externalId: 'bw1-6', imageUrl: 'https://images.pokemontcg.io/bw1/6.png', imageUrlLarge: 'https://images.pokemontcg.io/bw1/6_hires.png', market: 8.00, cost: 4.00 },
  { name: 'Emboar', setName: 'Black & White', setNumber: '19/114', variant: 'Holo Rare', externalId: 'bw1-19', imageUrl: 'https://images.pokemontcg.io/bw1/19.png', imageUrlLarge: 'https://images.pokemontcg.io/bw1/19_hires.png', market: 7.00, cost: 4.00 },
  { name: 'Samurott', setName: 'Black & White', setNumber: '31/114', variant: 'Holo Rare', externalId: 'bw1-31', imageUrl: 'https://images.pokemontcg.io/bw1/31.png', imageUrlLarge: 'https://images.pokemontcg.io/bw1/31_hires.png', market: 7.00, cost: 4.00 },

  // XY
  { name: 'Xerneas', setName: 'XY', setNumber: '96/146', variant: 'Holo Rare', externalId: 'xy1-96', imageUrl: 'https://images.pokemontcg.io/xy1/96.png', imageUrlLarge: 'https://images.pokemontcg.io/xy1/96_hires.png', market: 12.00, cost: 7.00 },
  { name: 'Yveltal', setName: 'XY', setNumber: '98/146', variant: 'Holo Rare', externalId: 'xy1-98', imageUrl: 'https://images.pokemontcg.io/xy1/98.png', imageUrlLarge: 'https://images.pokemontcg.io/xy1/98_hires.png', market: 12.00, cost: 7.00 },
  { name: 'Sylveon', setName: 'XY', setNumber: '72/146', variant: 'Holo Rare', externalId: 'xy1-72', imageUrl: 'https://images.pokemontcg.io/xy1/72.png', imageUrlLarge: 'https://images.pokemontcg.io/xy1/72_hires.png', market: 15.00, cost: 9.00 },

  // Evolutions
  { name: 'Charizard', setName: 'Evolutions', setNumber: '11/108', variant: 'Holo Rare', externalId: 'xy12-11', imageUrl: 'https://images.pokemontcg.io/xy12/11.png', imageUrlLarge: 'https://images.pokemontcg.io/xy12/11_hires.png', market: 65.00, cost: 40.00 },
  { name: 'Blastoise', setName: 'Evolutions', setNumber: '17/108', variant: 'Holo Rare', externalId: 'xy12-17', imageUrl: 'https://images.pokemontcg.io/xy12/17.png', imageUrlLarge: 'https://images.pokemontcg.io/xy12/17_hires.png', market: 22.00, cost: 13.00 },
  { name: 'Venusaur', setName: 'Evolutions', setNumber: '3/108', variant: 'Holo Rare', externalId: 'xy12-3', imageUrl: 'https://images.pokemontcg.io/xy12/3.png', imageUrlLarge: 'https://images.pokemontcg.io/xy12/3_hires.png', market: 18.00, cost: 10.00 },
  { name: 'Pikachu', setName: 'Evolutions', setNumber: '35/108', variant: null, externalId: 'xy12-35', imageUrl: 'https://images.pokemontcg.io/xy12/35.png', imageUrlLarge: 'https://images.pokemontcg.io/xy12/35_hires.png', market: 5.00, cost: 3.00 },

  // Sun & Moon
  { name: 'Solgaleo GX', setName: 'Sun & Moon', setNumber: '89/149', variant: 'GX', externalId: 'sm1-89', imageUrl: 'https://images.pokemontcg.io/sm1/89.png', imageUrlLarge: 'https://images.pokemontcg.io/sm1/89_hires.png', market: 14.00, cost: 8.00 },
  { name: 'Lunala GX', setName: 'Sun & Moon', setNumber: '66/149', variant: 'GX', externalId: 'sm1-66', imageUrl: 'https://images.pokemontcg.io/sm1/66.png', imageUrlLarge: 'https://images.pokemontcg.io/sm1/66_hires.png', market: 14.00, cost: 8.00 },
  { name: 'Incineroar GX', setName: 'Sun & Moon', setNumber: '27/149', variant: 'GX', externalId: 'sm1-27', imageUrl: 'https://images.pokemontcg.io/sm1/27.png', imageUrlLarge: 'https://images.pokemontcg.io/sm1/27_hires.png', market: 10.00, cost: 6.00 },
  { name: 'Decidueye GX', setName: 'Sun & Moon', setNumber: '12/149', variant: 'GX', externalId: 'sm1-12', imageUrl: 'https://images.pokemontcg.io/sm1/12.png', imageUrlLarge: 'https://images.pokemontcg.io/sm1/12_hires.png', market: 10.00, cost: 6.00 },
  { name: 'Primarina GX', setName: 'Sun & Moon', setNumber: '42/149', variant: 'GX', externalId: 'sm1-42', imageUrl: 'https://images.pokemontcg.io/sm1/42.png', imageUrlLarge: 'https://images.pokemontcg.io/sm1/42_hires.png', market: 9.00, cost: 5.00 },

  // Burning Shadows
  { name: 'Charizard GX', setName: 'Burning Shadows', setNumber: '20/147', variant: 'GX', externalId: 'sm3-20', imageUrl: 'https://images.pokemontcg.io/sm3/20.png', imageUrlLarge: 'https://images.pokemontcg.io/sm3/20_hires.png', market: 45.00, cost: 28.00 },
  { name: 'Lycanroc GX', setName: 'Burning Shadows', setNumber: '74/147', variant: 'GX', externalId: 'sm3-74', imageUrl: 'https://images.pokemontcg.io/sm3/74.png', imageUrlLarge: 'https://images.pokemontcg.io/sm3/74_hires.png', market: 12.00, cost: 7.00 },
  { name: 'Marshadow GX', setName: 'Burning Shadows', setNumber: '80/147', variant: 'GX', externalId: 'sm3-80', imageUrl: 'https://images.pokemontcg.io/sm3/80.png', imageUrlLarge: 'https://images.pokemontcg.io/sm3/80_hires.png', market: 18.00, cost: 11.00 },

  // Hidden Fates
  { name: 'Charizard GX', setName: 'Hidden Fates', setNumber: 'SV49/SV94', variant: 'Shiny GX', externalId: 'sma-sv49', imageUrl: 'https://images.pokemontcg.io/sma/sv49.png', imageUrlLarge: 'https://images.pokemontcg.io/sma/sv49_hires.png', market: 165.00, cost: 105.00 },
  { name: 'Mewtwo GX', setName: 'Hidden Fates', setNumber: 'SV53/SV94', variant: 'Shiny GX', externalId: 'sma-sv53', imageUrl: 'https://images.pokemontcg.io/sma/sv53.png', imageUrlLarge: 'https://images.pokemontcg.io/sma/sv53_hires.png', market: 28.00, cost: 17.00 },
  { name: 'Pikachu GX', setName: 'Hidden Fates', setNumber: 'SV57/SV94', variant: 'Shiny GX', externalId: 'sma-sv57', imageUrl: 'https://images.pokemontcg.io/sma/sv57.png', imageUrlLarge: 'https://images.pokemontcg.io/sma/sv57_hires.png', market: 35.00, cost: 22.00 },
  { name: 'Eevee GX', setName: 'Hidden Fates', setNumber: 'SV71/SV94', variant: 'Shiny GX', externalId: 'sma-sv71', imageUrl: 'https://images.pokemontcg.io/sma/sv71.png', imageUrlLarge: 'https://images.pokemontcg.io/sma/sv71_hires.png', market: 22.00, cost: 13.00 },

  // Sword & Shield
  { name: 'Zacian V', setName: 'Sword & Shield', setNumber: '138/202', variant: 'V', externalId: 'swsh1-138', imageUrl: 'https://images.pokemontcg.io/swsh1/138.png', imageUrlLarge: 'https://images.pokemontcg.io/swsh1/138_hires.png', market: 20.00, cost: 12.00 },
  { name: 'Zamazenta V', setName: 'Sword & Shield', setNumber: '139/202', variant: 'V', externalId: 'swsh1-139', imageUrl: 'https://images.pokemontcg.io/swsh1/139.png', imageUrlLarge: 'https://images.pokemontcg.io/swsh1/139_hires.png', market: 8.00, cost: 5.00 },
  { name: 'Rillaboom', setName: 'Sword & Shield', setNumber: '14/202', variant: 'Holo Rare', externalId: 'swsh1-14', imageUrl: 'https://images.pokemontcg.io/swsh1/14.png', imageUrlLarge: 'https://images.pokemontcg.io/swsh1/14_hires.png', market: 5.00, cost: 3.00 },
  { name: 'Cinderace', setName: 'Sword & Shield', setNumber: '36/202', variant: 'Holo Rare', externalId: 'swsh1-36', imageUrl: 'https://images.pokemontcg.io/swsh1/36.png', imageUrlLarge: 'https://images.pokemontcg.io/swsh1/36_hires.png', market: 5.00, cost: 3.00 },
  { name: 'Inteleon', setName: 'Sword & Shield', setNumber: '58/202', variant: 'Holo Rare', externalId: 'swsh1-58', imageUrl: 'https://images.pokemontcg.io/swsh1/58.png', imageUrlLarge: 'https://images.pokemontcg.io/swsh1/58_hires.png', market: 5.00, cost: 3.00 },

  // Shining Fates
  { name: 'Charizard VMAX', setName: 'Shining Fates', setNumber: 'SV107/SV122', variant: 'Shiny VMAX', externalId: 'swsh45sv-sv107', imageUrl: 'https://images.pokemontcg.io/swsh45sv/sv107.png', imageUrlLarge: 'https://images.pokemontcg.io/swsh45sv/sv107_hires.png', market: 95.00, cost: 60.00 },
  { name: 'Pikachu V', setName: 'Shining Fates', setNumber: 'SV59/SV122', variant: 'Shiny V', externalId: 'swsh45sv-sv59', imageUrl: 'https://images.pokemontcg.io/swsh45sv/sv59.png', imageUrlLarge: 'https://images.pokemontcg.io/swsh45sv/sv59_hires.png', market: 28.00, cost: 17.00 },
  { name: 'Eevee VMAX', setName: 'Shining Fates', setNumber: 'SV36/SV122', variant: 'Shiny VMAX', externalId: 'swsh45sv-sv36', imageUrl: 'https://images.pokemontcg.io/swsh45sv/sv36.png', imageUrlLarge: 'https://images.pokemontcg.io/swsh45sv/sv36_hires.png', market: 22.00, cost: 13.00 },

  // Brilliant Stars
  { name: 'Arceus VSTAR', setName: 'Brilliant Stars', setNumber: '123/172', variant: 'VSTAR', externalId: 'swsh9-123', imageUrl: 'https://images.pokemontcg.io/swsh9/123.png', imageUrlLarge: 'https://images.pokemontcg.io/swsh9/123_hires.png', market: 22.00, cost: 13.00 },
  { name: 'Charizard V', setName: 'Brilliant Stars', setNumber: '17/172', variant: 'V', externalId: 'swsh9-17', imageUrl: 'https://images.pokemontcg.io/swsh9/17.png', imageUrlLarge: 'https://images.pokemontcg.io/swsh9/17_hires.png', market: 18.00, cost: 11.00 },
  { name: 'Mimikyu VSTAR', setName: 'Brilliant Stars', setNumber: '113/172', variant: 'VSTAR', externalId: 'swsh9-113', imageUrl: 'https://images.pokemontcg.io/swsh9/113.png', imageUrlLarge: 'https://images.pokemontcg.io/swsh9/113_hires.png', market: 12.00, cost: 7.00 },

  // Lost Origin
  { name: 'Giratina VSTAR', setName: 'Lost Origin', setNumber: '131/196', variant: 'VSTAR', externalId: 'swsh11-131', imageUrl: 'https://images.pokemontcg.io/swsh11/131.png', imageUrlLarge: 'https://images.pokemontcg.io/swsh11/131_hires.png', market: 30.00, cost: 18.00 },
  { name: 'Aerodactyl V', setName: 'Lost Origin', setNumber: '92/196', variant: 'V', externalId: 'swsh11-92', imageUrl: 'https://images.pokemontcg.io/swsh11/92.png', imageUrlLarge: 'https://images.pokemontcg.io/swsh11/92_hires.png', market: 8.00, cost: 5.00 },

  // Scarlet & Violet
  { name: 'Koraidon ex', setName: 'Scarlet & Violet', setNumber: '254/198', variant: 'ex Special Art', externalId: 'sv1-254', imageUrl: 'https://images.pokemontcg.io/sv1/254.png', imageUrlLarge: 'https://images.pokemontcg.io/sv1/254_hires.png', market: 35.00, cost: 22.00 },
  { name: 'Miraidon ex', setName: 'Scarlet & Violet', setNumber: '255/198', variant: 'ex Special Art', externalId: 'sv1-255', imageUrl: 'https://images.pokemontcg.io/sv1/255.png', imageUrlLarge: 'https://images.pokemontcg.io/sv1/255_hires.png', market: 35.00, cost: 22.00 },
  { name: 'Charizard ex', setName: 'Scarlet & Violet', setNumber: '6/198', variant: 'ex', externalId: 'sv1-6', imageUrl: 'https://images.pokemontcg.io/sv1/6.png', imageUrlLarge: 'https://images.pokemontcg.io/sv1/6_hires.png', market: 25.00, cost: 15.00 },
  { name: 'Mewtwo ex', setName: 'Scarlet & Violet', setNumber: '205/198', variant: 'ex Special Art', externalId: 'sv1-205', imageUrl: 'https://images.pokemontcg.io/sv1/205.png', imageUrlLarge: 'https://images.pokemontcg.io/sv1/205_hires.png', market: 28.00, cost: 17.00 },

  // Obsidian Flames
  { name: 'Charizard ex', setName: 'Obsidian Flames', setNumber: '125/197', variant: 'ex Special Art', externalId: 'sv3-125', imageUrl: 'https://images.pokemontcg.io/sv3/125.png', imageUrlLarge: 'https://images.pokemontcg.io/sv3/125_hires.png', market: 55.00, cost: 35.00 },
  { name: 'Tyranitar ex', setName: 'Obsidian Flames', setNumber: '120/197', variant: 'ex Special Art', externalId: 'sv3-120', imageUrl: 'https://images.pokemontcg.io/sv3/120.png', imageUrlLarge: 'https://images.pokemontcg.io/sv3/120_hires.png', market: 15.00, cost: 9.00 },
  { name: 'Revavroom ex', setName: 'Obsidian Flames', setNumber: '240/197', variant: 'ex Special Art', externalId: 'sv3-240', imageUrl: 'https://images.pokemontcg.io/sv3/240.png', imageUrlLarge: 'https://images.pokemontcg.io/sv3/240_hires.png', market: 12.00, cost: 7.00 },

  // Paradox Rift
  { name: 'Roaring Moon ex', setName: 'Paradox Rift', setNumber: '229/182', variant: 'ex Special Art', externalId: 'sv4-229', imageUrl: 'https://images.pokemontcg.io/sv4/229.png', imageUrlLarge: 'https://images.pokemontcg.io/sv4/229_hires.png', market: 45.00, cost: 28.00 },
  { name: 'Iron Valiant ex', setName: 'Paradox Rift', setNumber: '230/182', variant: 'ex Special Art', externalId: 'sv4-230', imageUrl: 'https://images.pokemontcg.io/sv4/230.png', imageUrlLarge: 'https://images.pokemontcg.io/sv4/230_hires.png', market: 30.00, cost: 18.00 },
  { name: 'Flutter Mane ex', setName: 'Paradox Rift', setNumber: '226/182', variant: 'ex Special Art', externalId: 'sv4-226', imageUrl: 'https://images.pokemontcg.io/sv4/226.png', imageUrlLarge: 'https://images.pokemontcg.io/sv4/226_hires.png', market: 22.00, cost: 13.00 },

  // Temporal Forces
  { name: 'Raging Bolt ex', setName: 'Temporal Forces', setNumber: '123/162', variant: 'ex Special Art', externalId: 'sv5-123', imageUrl: 'https://images.pokemontcg.io/sv5/123.png', imageUrlLarge: 'https://images.pokemontcg.io/sv5/123_hires.png', market: 38.00, cost: 24.00 },
  { name: 'Iron Crown ex', setName: 'Temporal Forces', setNumber: '227/162', variant: 'ex Special Art', externalId: 'sv5-227', imageUrl: 'https://images.pokemontcg.io/sv5/227.png', imageUrlLarge: 'https://images.pokemontcg.io/sv5/227_hires.png', market: 28.00, cost: 17.00 },
  { name: 'Walking Wake ex', setName: 'Temporal Forces', setNumber: '50/162', variant: 'ex', externalId: 'sv5-50', imageUrl: 'https://images.pokemontcg.io/sv5/50.png', imageUrlLarge: 'https://images.pokemontcg.io/sv5/50_hires.png', market: 12.00, cost: 7.00 },

  // Twilight Masquerade
  { name: 'Teal Mask Ogerpon ex', setName: 'Twilight Masquerade', setNumber: '25/167', variant: 'ex', externalId: 'sv6-25', imageUrl: 'https://images.pokemontcg.io/sv6/25.png', imageUrlLarge: 'https://images.pokemontcg.io/sv6/25_hires.png', market: 18.00, cost: 11.00 },
  { name: 'Bloodmoon Ursaluna ex', setName: 'Twilight Masquerade', setNumber: '141/167', variant: 'ex Special Art', externalId: 'sv6-141', imageUrl: 'https://images.pokemontcg.io/sv6/141.png', imageUrlLarge: 'https://images.pokemontcg.io/sv6/141_hires.png', market: 35.00, cost: 22.00 },

  // Stellar Crown
  { name: 'Pikachu ex', setName: 'Stellar Crown', setNumber: '67/142', variant: 'ex', externalId: 'sv7-67', imageUrl: 'https://images.pokemontcg.io/sv7/67.png', imageUrlLarge: 'https://images.pokemontcg.io/sv7/67_hires.png', market: 22.00, cost: 13.00 },
  { name: 'Terapagos ex', setName: 'Stellar Crown', setNumber: '128/142', variant: 'ex Special Art', externalId: 'sv7-128', imageUrl: 'https://images.pokemontcg.io/sv7/128.png', imageUrlLarge: 'https://images.pokemontcg.io/sv7/128_hires.png', market: 45.00, cost: 28.00 },
  { name: 'Scizor ex', setName: 'Stellar Crown', setNumber: '131/142', variant: 'ex Special Art', externalId: 'sv7-131', imageUrl: 'https://images.pokemontcg.io/sv7/131.png', imageUrlLarge: 'https://images.pokemontcg.io/sv7/131_hires.png', market: 15.00, cost: 9.00 },
]

const CONDITIONS: Array<'NM' | 'LP' | 'MP'> = ['NM', 'LP', 'MP']

async function main() {
  console.log(`Seeding ${MOCK_CARDS.length} cards...`)
  let inserted = 0
  let skipped = 0

  for (const card of MOCK_CARDS) {
    // Check for existing card
    const existing = await db.select({ id: schema.cards.id })
      .from(schema.cards)
      .where(eq(schema.cards.externalId, card.externalId))
      .limit(1)

    let cardId: number

    if (existing.length > 0) {
      cardId = existing[0].id
      skipped++
    } else {
      const [inserted_card] = await db.insert(schema.cards).values({
        name: card.name,
        game: 'pokemon',
        setName: card.setName,
        setNumber: card.setNumber,
        variant: card.variant ?? null,
        language: 'EN',
        externalId: card.externalId,
        imageUrl: card.imageUrl,
        imageUrlLarge: card.imageUrlLarge,
      }).returning({ id: schema.cards.id })
      cardId = inserted_card.id
      inserted++
    }

    // Price cache
    const existingPrice = await db.select({ id: schema.priceCache.id })
      .from(schema.priceCache)
      .where(eq(schema.priceCache.cardId, cardId))
      .limit(1)

    if (existingPrice.length === 0) {
      // MOCK_CARDS values are pounds; DB stores pence
      await db.insert(schema.priceCache).values({
        cardId,
        tcgplayerMarket: parsePounds(card.market),
        tcgplayerLow: parsePounds(card.market * 0.85),
        tcgplayerMid: parsePounds(card.market * 0.95),
        tcgplayerHigh: parsePounds(card.market * 1.1),
        isHighValue: parsePounds(card.market) >= 5000,
      })
    }

    // Inventory item (1-3 copies in random condition)
    const copies = Math.floor(Math.random() * 3) + 1
    for (let i = 0; i < copies; i++) {
      const condition = CONDITIONS[Math.floor(Math.random() * (card.market > 50 ? 1 : CONDITIONS.length))]
      await db.insert(schema.inventoryItems).values({
        cardId,
        condition,
        quantity: Math.floor(Math.random() * 3) + 1,
        costPrice: parsePounds(card.cost),
        sellPriceOverride: null,
        qrCode: randomUUID(),
        location: null,
        defectNotes: null,
        lowStockThreshold: 1,
      })
    }
  }

  console.log(`Done! ${inserted} cards inserted, ${skipped} already existed.`)
  console.log(`Inventory items created for all cards.`)
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
