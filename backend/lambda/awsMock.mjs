export function stubClients(clients) {
  const calls = [];
  const restoreFns = [];
  for (const [clientName, spec] of Object.entries(clients)) {
    const original = spec.client.send.bind(spec.client);
    spec.client.send = async (command) => {
      const name = command.constructor.name;
      calls.push({ client: clientName, name, input: command.input });
      const respond = spec.responders[name];
      if (!respond) throw new Error(`no ${clientName} mock for ${name}`);
      return respond(command.input);
    };
    restoreFns.push(() => {
      spec.client.send = original;
    });
  }
  return {
    calls,
    named(name) {
      return calls.filter((call) => call.name === name);
    },
    restore() {
      for (const restoreFn of restoreFns) restoreFn();
    },
  };
}
