declare module '@appdeploy/sdk' {
  export const db: {
    add(table:string,records:Array<Record<string,unknown>>):Promise<Array<string|null>>;
    update(table:string,items:Array<{id:string;record:Record<string,unknown>}>):Promise<boolean[]>;
    list<T=Record<string,unknown>>(table:string,options?:{limit?:number;nextToken?:string}):Promise<{items:Array<T&{id:string}>;nextToken?:string}>;
  };
  export const secrets: {
    readSecret(name:string):Promise<string>;
    listSecretNames():Promise<string[]>;
  };
  export const notifications: {
    send(input:{userIds:string[];notification:{title:string;body:string};data?:Record<string,unknown>}):Promise<unknown>;
  };
  export function json(data:unknown,status?:number):{statusCode:number;headers:Record<string,string>;body:string};
  export function error(message:string,status?:number):{statusCode:number;headers:Record<string,string>;body:string};
}
