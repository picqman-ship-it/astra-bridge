// Reserve the selected staging hostname before Access is configured.
// No tool service, storage, secrets, agent connection or pairing is exposed.
export default {
  fetch() {
    return new Response('Staging not enabled.\n', {
      status: 404,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  },
};
