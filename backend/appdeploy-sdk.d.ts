declare module '@appdeploy/sdk' {
  export type RouterResponse={statusCode:number;headers?:Record<string,string>;body?:string};
  export type RouterContext={
    body:unknown;
    query:Record<string,string>;
    params:Record<string,string>;
    event:unknown;
    user?:{userId:string;email?:string;name?:string;scope:string};
  };
  export type RouterMiddleware=(context:RouterContext)=>RouterResponse|void|Promise<RouterResponse|void>;
  export const db: {
    add(table:string,records:Array<Record<string,unknown>>):Promise<Array<string|null>>;
    update(table:string,items:Array<{id:string;record:Record<string,unknown>}>):Promise<boolean[]>;
    list<T=Record<string,unknown>>(table:string,options?:{limit?:number;nextToken?:string}):Promise<{items:Array<T&{id:string}>;nextToken?:string}>;
    get<T=Record<string,unknown>>(table:string,ids:string[]):Promise<Array<(T&{id:string})|null>>;
    delete(table:string,ids:string[]):Promise<boolean[]>;
  };
  export const secrets: {
    readSecret(name:string):Promise<string>;
    listSecretNames():Promise<string[]>;
  };
  export const notifications: {
    send(input:{userIds:string[];notification:{title:string;body:string};data?:Record<string,unknown>}):Promise<unknown>;
  };
  export function router(routes:Record<string,RouterMiddleware[]>):(event:unknown)=>Promise<RouterResponse>;
  export function requireAuth():RouterMiddleware;
  export function json(data:unknown,status?:number):{statusCode:number;headers:Record<string,string>;body:string};
  export function error(message:string,status?:number):{statusCode:number;headers:Record<string,string>;body:string};
}
